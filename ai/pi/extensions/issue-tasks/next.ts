import { Data, Effect, Either, Option, Schema } from "effect"
import {
  decodeIssueRepository,
  issueKey,
  type IssueReference,
  type IssueRepository,
} from "./identity.ts"
import {
  MAX_GITHUB_PROJECT_PAGE_SIZE,
  type GitHubProjectReader,
  type GitHubProjectItem,
  type GitHubSchedulingProject,
} from "./github-project-read.ts"
import {
  MAX_GITHUB_ISSUE_PAGE_SIZE,
  type GitHubIssueReader,
  type GitHubReadError,
} from "./github-read.ts"
import {
  MAX_ISSUE_SELECTION_CANDIDATES,
  selectIssueAssignment,
  type IssueAssignmentSelection,
  type IssueSelectionCandidate,
  type IssueSelectionError,
} from "./selector.ts"
import {
  MAX_TASK_PAGE_SIZE,
  type IssueTask,
  type TaskAddress,
  type TaskStatus,
} from "./model.ts"
import type { SqliteTaskStore, TaskStoreError } from "./sqlite-store.ts"

export interface IssueNextQuery {
  readonly repository: IssueRepository
  readonly project: GitHubSchedulingProject
}

export interface IssueNextProgress {
  readonly stage: "project" | "issues" | "tasks"
  readonly reads: number
}

export class IssueNextReadError extends Data.TaggedError("IssueNextReadError")<{
  readonly code:
    | "invalid_request"
    | "inconsistent_readback"
    | "capacity"
    | "observer_unavailable"
    | "unavailable"
  readonly message: string
}> {}

export type IssueNextReadFailure =
  IssueNextReadError | GitHubReadError | TaskStoreError | IssueSelectionError

export type IssueNextObserver = (
  progress: IssueNextProgress,
) => Effect.Effect<void, IssueNextReadError>

export interface IssueNextReaderOptions {
  readonly projects: GitHubProjectReader
  readonly github: Pick<GitHubIssueReader, "get">
  readonly tasks: Pick<SqliteTaskStore, "readTasks" | "readTask">
}

export interface IssueNextReader {
  readonly next: (
    input: unknown,
    observe?: IssueNextObserver,
  ) => Effect.Effect<IssueAssignmentSelection, IssueNextReadFailure>
}

const readError = (code: IssueNextReadError["code"]): IssueNextReadError =>
  new IssueNextReadError({
    code,
    message: {
      invalid_request:
        "Next issue requires only a qualified repository and an existing Project alias",
      inconsistent_readback:
        "Issue selection sources changed or returned inconsistent qualified coverage",
      capacity: "Complete issue selection exceeds the source read budget",
      observer_unavailable: "Issue selection progress could not be reported",
      unavailable: "Issue selection source is unavailable",
    }[code],
  })

const QuerySchema = Schema.Struct({
  repository: Schema.Unknown,
  project: Schema.Literal("personal", "dataclique"),
})

const decodeQuery = (input: unknown) =>
  Either.try({
    try: () =>
      Either.gen(function* () {
        const raw = yield* Schema.decodeUnknownEither(QuerySchema, {
          onExcessProperty: "error",
        })(input).pipe(Either.mapLeft(() => readError("invalid_request")))
        const repository = yield* decodeIssueRepository(raw.repository).pipe(
          Either.mapLeft(() => readError("invalid_request")),
        )
        return Object.freeze({ repository, project: raw.project })
      }),
    catch: () => readError("invalid_request"),
  }).pipe(Either.flatMap(result => result))

type ProjectIssue = Extract<GitHubProjectItem, { readonly kind: "issue" }>

const addressKey = (address: TaskAddress): string =>
  `${issueKey(address.issue)}/${address.id}`

/** Reads observations only; the result never grants execution or closes issues. */
export const createIssueNextReader = (
  options: IssueNextReaderOptions,
): IssueNextReader => {
  const captured = Either.try({
    try: () => ({
      project: options.projects.read,
      issue: options.github.get,
      pages: options.tasks.readTasks,
      task: options.tasks.readTask,
    }),
    catch: () => readError("unavailable"),
  })

  return Object.freeze({
    next: (input: unknown, observe?: IssueNextObserver) =>
      Effect.gen(function* () {
        yield* Effect.yieldNow()
        const query = yield* decodeQuery(input)
        const ports = yield* captured
        let reads = 0
        let taskCount = 0
        let relationCount = 0

        const call = <A, E>(
          stage: IssueNextProgress["stage"],
          action: () => Effect.Effect<A, E>,
        ): Effect.Effect<A, E | IssueNextReadError> =>
          Effect.gen(function* () {
            if (reads >= MAX_ISSUE_SELECTION_CANDIDATES)
              return yield* Effect.fail(readError("capacity"))
            reads += 1
            if (observe !== undefined)
              yield* Effect.suspend(() =>
                observe(Object.freeze({ stage, reads })),
              ).pipe(
                Effect.mapError(() => readError("observer_unavailable")),
                Effect.catchAllDefect(() =>
                  Effect.fail(readError("observer_unavailable")),
                ),
              )
            return yield* Effect.suspend(action).pipe(
              Effect.catchAllDefect(() =>
                Effect.fail(readError("unavailable")),
              ),
            )
          })

        const revisions = new Map<string, number | null>()
        const recordRevision = (
          issue: IssueReference,
          revision: number | null,
        ) => {
          const key = issueKey(issue)
          if (
            (revision !== null &&
              (!Number.isSafeInteger(revision) || revision < 0)) ||
            (revisions.has(key) && revisions.get(key) !== revision)
          )
            return Effect.fail(readError("inconsistent_readback"))
          revisions.set(key, revision)
          return Effect.void
        }

        const states = new Map<
          string,
          { readonly state: "open" | "closed"; readonly updatedAt: string }
        >()
        const metadata = (
          issue: IssueReference,
          after?: string,
          limit = MAX_GITHUB_ISSUE_PAGE_SIZE,
        ) =>
          Effect.gen(function* () {
            const result = yield* call("issues", () =>
              ports.issue({
                issue,
                related: {
                  limit,
                  ...(after === undefined ? {} : { blockedByAfter: after }),
                },
              }),
            )
            const detail = result.detail
            if (
              issueKey(result.issue) !== issueKey(issue) ||
              detail === null ||
              issueKey(detail.issue) !== issueKey(issue)
            )
              return yield* Effect.fail(readError("inconsistent_readback"))
            const previous = states.get(issueKey(issue))
            if (
              previous !== undefined &&
              (previous.state !== detail.state ||
                previous.updatedAt !== detail.updatedAt)
            )
              return yield* Effect.fail(readError("inconsistent_readback"))
            states.set(issueKey(issue), {
              state: detail.state,
              updatedAt: detail.updatedAt,
            })
            return {
              state: detail.state,
              issues: detail.blockedBy.issues.map(reference =>
                Object.freeze({ ...reference }),
              ),
              pageInfo: detail.blockedBy.pageInfo,
            }
          })

        const dependencies = (item: ProjectIssue) =>
          Effect.gen(function* () {
            let after: string | undefined
            let blocked = false
            const cursors = new Set<string>()
            const seen = new Set<string>()
            while (true) {
              const page = yield* metadata(item.issue, after)
              if (page.state !== item.state)
                return yield* Effect.fail(readError("inconsistent_readback"))
              for (const issue of page.issues) {
                const key = issueKey(issue)
                if (seen.has(key))
                  return yield* Effect.fail(readError("inconsistent_readback"))
                seen.add(key)
                relationCount += 1
                if (relationCount > MAX_ISSUE_SELECTION_CANDIDATES)
                  return yield* Effect.fail(readError("capacity"))
                const known = states.get(key)
                const state =
                  known === undefined
                    ? (yield* metadata(issue, undefined, 1)).state
                    : known.state
                if (state === "open") blocked = true
              }
              if (!page.pageInfo.hasNextPage) break
              const next = page.pageInfo.endCursor
              if (cursors.has(next))
                return yield* Effect.fail(readError("inconsistent_readback"))
              cursors.add(next)
              after = next
            }
            return blocked ? ("blocked" as const) : ("clear" as const)
          })

        const taskStates = new Map<string, TaskStatus>()
        const prerequisiteDone = (address: TaskAddress) =>
          Effect.gen(function* () {
            const key = addressKey(address)
            const known = taskStates.get(key)
            if (known !== undefined) return known === "done"
            const read = yield* call("tasks", () =>
              ports.task(address.issue, address.id),
            )
            if (Option.isNone(read))
              return yield* Effect.fail(readError("inconsistent_readback"))
            const detail = read.value
            if (
              issueKey(detail.issue) !== issueKey(address.issue) ||
              detail.task.id !== address.id
            )
              return yield* Effect.fail(readError("inconsistent_readback"))
            yield* recordRevision(detail.issue, detail.revision)
            taskStates.set(key, detail.task.status)
            return detail.task.status === "done"
          })

        const runnable = (issue: IssueReference, row: IssueTask) =>
          Effect.gen(function* () {
            const read = yield* call("tasks", () => ports.task(issue, row.id))
            if (Option.isNone(read))
              return yield* Effect.fail(readError("inconsistent_readback"))
            const detail = read.value
            if (
              issueKey(detail.issue) !== issueKey(issue) ||
              detail.task.id !== row.id ||
              detail.task.status !== row.status ||
              detail.task.blocker !== row.blocker
            )
              return yield* Effect.fail(readError("inconsistent_readback"))
            yield* recordRevision(detail.issue, detail.revision)
            relationCount += detail.dependsOn.length
            if (relationCount > MAX_ISSUE_SELECTION_CANDIDATES)
              return yield* Effect.fail(readError("capacity"))
            for (const address of detail.dependsOn)
              if (!(yield* prerequisiteDone(address))) return false
            return true
          })

        const blockers = (issue: IssueReference) =>
          Effect.gen(function* () {
            let after: IssueTask["id"] | undefined
            let unfinished = false
            let ready = false
            const cursors = new Set<string>()
            const seen = new Set<string>()
            while (true) {
              const result = yield* call("tasks", () =>
                ports.pages(issue, {
                  limit: MAX_TASK_PAGE_SIZE,
                  ...(after === undefined ? {} : { after }),
                }),
              )
              if (Option.isNone(result)) {
                yield* recordRevision(issue, null)
                break
              }
              const page = result.value
              if (issueKey(page.issue) !== issueKey(issue))
                return yield* Effect.fail(readError("inconsistent_readback"))
              yield* recordRevision(issue, page.revision)
              for (const row of page.tasks) {
                if (seen.has(row.id))
                  return yield* Effect.fail(readError("inconsistent_readback"))
                seen.add(row.id)
                taskCount += 1
                if (taskCount > MAX_ISSUE_SELECTION_CANDIDATES)
                  return yield* Effect.fail(readError("capacity"))
                taskStates.set(addressKey({ issue, id: row.id }), row.status)
                if (row.status !== "todo" && row.status !== "doing") continue
                unfinished = true
                if (!ready && row.blocker === null)
                  ready = yield* runnable(issue, { ...row })
              }
              if (page.next === null) break
              if (cursors.has(page.next) || page.tasks.at(-1)?.id !== page.next)
                return yield* Effect.fail(readError("inconsistent_readback"))
              cursors.add(page.next)
              after = page.next
            }
            return unfinished && !ready
              ? ("blocked" as const)
              : ("clear" as const)
          })

        const items: ProjectIssue[] = []
        const itemIds = new Set<string>()
        const issueIds = new Set<string>()
        const cursors = new Set<string>()
        let after: string | undefined
        while (true) {
          const page = yield* call("project", () =>
            ports.project({
              project: query.project,
              page: {
                limit: MAX_GITHUB_PROJECT_PAGE_SIZE,
                ...(after === undefined ? {} : { after }),
              },
            }),
          )
          if (page.project !== query.project)
            return yield* Effect.fail(readError("inconsistent_readback"))
          for (const item of page.items) {
            if (itemIds.has(item.itemId))
              return yield* Effect.fail(readError("inconsistent_readback"))
            itemIds.add(item.itemId)
            if (itemIds.size > MAX_ISSUE_SELECTION_CANDIDATES)
              return yield* Effect.fail(readError("capacity"))
            if (item.kind !== "issue") continue
            const key = issueKey(item.issue)
            if (issueIds.has(key))
              return yield* Effect.fail(readError("inconsistent_readback"))
            issueIds.add(key)
            if (item.issue.repository === query.repository)
              items.push(
                Object.freeze({
                  ...item,
                  issue: Object.freeze({ ...item.issue }),
                  priority: Object.freeze({ ...item.priority }),
                  effort: Object.freeze({ ...item.effort }),
                }),
              )
          }
          if (!page.pageInfo.hasNextPage) break
          if (cursors.has(page.pageInfo.endCursor))
            return yield* Effect.fail(readError("inconsistent_readback"))
          cursors.add(page.pageInfo.endCursor)
          after = page.pageInfo.endCursor
        }

        const candidates: IssueSelectionCandidate[] = []
        for (const item of items)
          candidates.push({
            issue: item.issue,
            state: item.state,
            priority: item.priority,
            effort: item.effort,
            eligibility: {
              dependencies: yield* dependencies(item),
              blockers: yield* blockers(item.issue),
            },
          })

        return yield* selectIssueAssignment({
          scope: items.map(item => item.issue),
          coverage: "complete",
          candidates,
        })
      }).pipe(
        Effect.catchAllDefect(() => Effect.fail(readError("unavailable"))),
      ),
  })
}
