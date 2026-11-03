import { Data, Effect, Either, Schema } from "effect"
import {
  issueKey,
  type PlanInputError,
  type IssueRepository,
} from "./identity.ts"
import {
  decodeGitHubIssueListQuery,
  decodeGitHubIssueGetQuery,
  type GitHubIssueReader,
  type GitHubIssueListQuery,
  type GitHubIssueGetQuery,
  type GitHubIssueGetResult,
  type GitHubIssueSummary,
  type GitHubConnectionPageInfo,
  type GitHubReadError,
} from "./github-read.ts"
import { decodeTaskReadQueries } from "./request.ts"
import {
  MAX_TASK_PAGE_SIZE,
  TaskFilterSchema,
  type TaskFilter,
  type TaskPageInput,
  type IssueTaskPage,
  type TaskReadQuery,
  type IssueTaskPageResult,
} from "./model.ts"
import type { SqliteTaskStore, TaskStoreError } from "./sqlite-store.ts"

export interface IssueTaskListQuery extends GitHubIssueListQuery {
  readonly tasks: { readonly limit: number; readonly filter?: TaskFilter }
}
export interface IssueTaskGetQuery extends GitHubIssueGetQuery {
  readonly tasks: { readonly page: TaskPageInput; readonly filter?: TaskFilter }
}
export interface IssueTaskListView {
  readonly repository: IssueRepository
  readonly issues: readonly {
    readonly metadata: GitHubIssueSummary
    readonly tasks: IssueTaskPage | null
  }[]
  readonly pageInfo: GitHubConnectionPageInfo
}
export interface IssueTaskDetailView extends GitHubIssueGetResult {
  readonly tasks: IssueTaskPage | null
}
export class IssueTaskReadError extends Data.TaggedError("IssueTaskReadError")<{
  readonly code: "invalid_request" | "inconsistent_readback"
  readonly message: string
}> {}
export type IssueTaskReadFailure =
  IssueTaskReadError | GitHubReadError | PlanInputError | TaskStoreError
export interface IssueTaskReaderOptions {
  readonly github: GitHubIssueReader
  readonly tasks: Pick<SqliteTaskStore, "readManyTasks">
}
export interface IssueTaskReader {
  readonly list: (
    input: unknown,
  ) => Effect.Effect<IssueTaskListView, IssueTaskReadFailure>
  readonly get: (
    input: unknown,
  ) => Effect.Effect<IssueTaskDetailView, IssueTaskReadFailure>
}
const readError = (code: IssueTaskReadError["code"]): IssueTaskReadError =>
  new IssueTaskReadError({
    code,
    message:
      code === "invalid_request"
        ? "Combined issue/task reads require explicit bounded qualified queries"
        : "Issue metadata and local task coverage do not match the requested targets",
  })

const shape = (
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  Reflect.ownKeys(input).every(
    key => typeof key === "string" && allowed.includes(key),
  ) &&
  required.every(key => Object.hasOwn(input, key))
const invalid = () => Either.left(readError("invalid_request"))
const LimitSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, MAX_TASK_PAGE_SIZE),
)

const reconcilePages = (
  queries: readonly TaskReadQuery[],
  pages: readonly IssueTaskPageResult[],
): Either.Either<void, IssueTaskReadError> => {
  if (
    pages.length !== queries.length ||
    queries.some((query, index) => {
      const page = pages[index]

      return (
        page === undefined ||
        issueKey(page.issue) !== issueKey(query.issue) ||
        (page.page !== null &&
          issueKey(page.page.issue) !== issueKey(query.issue))
      )
    })
  )
    return Either.left(readError("inconsistent_readback"))

  return Either.right(undefined)
}

export const decodeIssueTaskListQuery = (
  input: unknown,
): Either.Either<IssueTaskListQuery, IssueTaskReadError> =>
  Either.gen(function* () {
    if (
      !shape(
        input,
        ["repository", "state", "page", "tasks"],
        ["repository", "state", "page", "tasks"],
      ) ||
      !shape(input.tasks, ["limit", "filter"], ["limit"])
    )
      return yield* invalid()

    const query = yield* decodeGitHubIssueListQuery({
      repository: input.repository,
      state: input.state,
      page: input.page,
    }).pipe(Either.mapLeft(() => readError("invalid_request")))

    const limit = yield* Schema.decodeUnknownEither(LimitSchema)(
      input.tasks.limit,
    ).pipe(Either.mapLeft(() => readError("invalid_request")))
    const filter = yield* Schema.decodeUnknownEither(TaskFilterSchema)(
      input.tasks.filter === undefined ? {} : input.tasks.filter,
    ).pipe(Either.mapLeft(() => readError("invalid_request")))

    if (query.page.limit * limit > MAX_TASK_PAGE_SIZE) return yield* invalid()

    return Object.freeze({
      ...query,
      tasks: Object.freeze({
        limit,
        ...(input.tasks.filter === undefined
          ? {}
          : {
              filter: Object.freeze({
                ...(filter.status === undefined
                  ? {}
                  : { status: filter.status }),
                ...(filter.blocked === undefined
                  ? {}
                  : { blocked: filter.blocked }),
              }),
            }),
      }),
    })
  })
export const decodeIssueTaskGetQuery = (
  input: unknown,
): Either.Either<IssueTaskGetQuery, IssueTaskReadError> =>
  Either.gen(function* () {
    if (
      !shape(
        input,
        ["issue", "related", "tasks"],
        ["issue", "related", "tasks"],
      ) ||
      !shape(input.tasks, ["page", "filter"], ["page"])
    )
      return yield* invalid()

    const query = yield* decodeGitHubIssueGetQuery({
      issue: input.issue,
      related: input.related,
    }).pipe(Either.mapLeft(() => readError("invalid_request")))

    const reads = yield* decodeTaskReadQueries([
      {
        issue: query.issue,
        page: input.tasks.page,
        ...(input.tasks.filter === undefined
          ? {}
          : { filter: input.tasks.filter }),
      },
    ]).pipe(Either.mapLeft(() => readError("invalid_request")))

    const read = reads[0]

    if (read === undefined) return yield* invalid()

    return Object.freeze({
      ...query,
      tasks: Object.freeze({
        page: read.page,
        ...(read.filter === undefined ? {} : { filter: read.filter }),
      }),
    })
  })
export const createIssueTaskReader = (
  options: IssueTaskReaderOptions,
): IssueTaskReader => ({
  list: input =>
    Effect.gen(function* () {
      yield* Effect.yieldNow()

      const query = yield* decodeIssueTaskListQuery(input)

      const metadata = yield* options.github.list({
        repository: query.repository,
        state: query.state,
        page: query.page,
      })

      if (
        metadata.repository !== query.repository ||
        metadata.issues.length > query.page.limit ||
        metadata.issues.some(row => row.issue.repository !== query.repository)
      )
        return yield* Effect.fail(readError("inconsistent_readback"))

      if (metadata.issues.length === 0)
        return Object.freeze({ ...metadata, issues: Object.freeze([]) })

      const queries = yield* decodeTaskReadQueries(
        metadata.issues.map(row => ({
          issue: row.issue,
          page: { limit: query.tasks.limit },
          ...(query.tasks.filter === undefined
            ? {}
            : { filter: query.tasks.filter }),
        })),
      ).pipe(Either.mapLeft(() => readError("inconsistent_readback")))

      const pages = yield* options.tasks.readManyTasks(queries)

      yield* reconcilePages(queries, pages)

      const issues = yield* Effect.forEach(pages, (page, index) => {
        const row = metadata.issues[index]

        return row === undefined
          ? Effect.fail(readError("inconsistent_readback"))
          : Effect.succeed(Object.freeze({ metadata: row, tasks: page.page }))
      })

      return Object.freeze({
        repository: metadata.repository,
        issues: Object.freeze(issues),
        pageInfo: metadata.pageInfo,
      })
    }),
  get: input =>
    Effect.gen(function* () {
      yield* Effect.yieldNow()

      const query = yield* decodeIssueTaskGetQuery(input)

      const metadata = yield* options.github.get({
        issue: query.issue,
        related: query.related,
      })

      if (
        issueKey(metadata.issue) !== issueKey(query.issue) ||
        (metadata.detail !== null &&
          issueKey(metadata.detail.issue) !== issueKey(query.issue))
      )
        return yield* Effect.fail(readError("inconsistent_readback"))

      const queries = [{ issue: query.issue, ...query.tasks }]
      const pages = yield* options.tasks.readManyTasks(queries)

      yield* reconcilePages(queries, pages)

      const page = pages[0]

      if (page === undefined)
        return yield* Effect.fail(readError("inconsistent_readback"))

      return Object.freeze({ ...metadata, tasks: page.page })
    }),
})
