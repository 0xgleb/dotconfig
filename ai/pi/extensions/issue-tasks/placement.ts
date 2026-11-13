import { Effect, Either, Option, Schema } from "effect"
import { GitHubReadError, MAX_GITHUB_READ_BYTES } from "./github-read.ts"
import {
  decodeIssueReference,
  issueKey,
  type IssueReference,
} from "./identity.ts"
import {
  configuredTaskProject,
  GitHubInProgressTargetSchema,
  GitHubIssueNodeIdSchema,
  ProjectItemIdSchema,
} from "./github-project-read.ts"
import type {
  GitHubInProgressTarget,
  GitHubProjectItemId,
  GitHubIssueNodeId,
  GitHubSchedulingProject,
} from "./github-project-read.ts"
import { IssuePickupWriteError } from "./pickup.ts"
import type { TaskApplyResult } from "./sqlite-store.ts"
import type { TaskNativeCall } from "./tool.ts"

export const GITHUB_PROJECT_MEMBERSHIP_DOCUMENT = `query TaskProjectMembership($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      id number repository { nameWithOwner }
      projectItems(first: $first, after: $after, includeArchived: true) {
        nodes { id isArchived project { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

export const GITHUB_PROJECT_PLACEMENT_DOCUMENT = `mutation TaskProjectPlacement($input: AddProjectV2ItemByIdInput!) {
  addProjectV2ItemById(input: $input) {
    item { id isArchived project { id } content { ... on Issue { id number repository { nameWithOwner } } } }
  }
}`

export interface GitHubProjectMembershipExecution {
  readonly document: typeof GITHUB_PROJECT_MEMBERSHIP_DOCUMENT
  readonly variables: {
    readonly owner: string
    readonly name: string
    readonly number: number
    readonly first: number
    readonly after: string | null
  }
}

export interface GitHubProjectPlacementExecution {
  readonly document: typeof GITHUB_PROJECT_PLACEMENT_DOCUMENT
  readonly variables: {
    readonly input: {
      readonly projectId: GitHubInProgressTarget["projectId"]
      readonly contentId: GitHubIssueNodeId
      readonly clientMutationId: string
    }
  }
}

export type ProjectPlacementObservation =
  | {
      readonly kind: "linked"
      readonly issue: IssueReference
      readonly project: GitHubSchedulingProject
      readonly itemId: GitHubProjectItemId
      readonly archived: boolean
      readonly write: "not_needed" | "acknowledged" | "possible"
    }
  | {
      readonly kind: "failed"
      readonly issue: IssueReference
      readonly project: GitHubSchedulingProject
      readonly reason: "unavailable" | "invalid_response" | "transport_error"
    }
  | {
      readonly kind: "unknown"
      readonly issue: IssueReference
      readonly project: GitHubSchedulingProject
    }
  | {
      readonly kind: "not_attempted"
      readonly issue: IssueReference
      readonly reason:
        "unsupported_owner" | "cancelled" | "unavailable" | "budget"
    }

export interface TaskProjectPlacement {
  readonly placeAffected: (
    saved: TaskApplyResult,
    invocation: TaskNativeCall,
    observe?: (observations: readonly ProjectPlacementObservation[]) => void,
  ) => Effect.Effect<readonly ProjectPlacementObservation[]>
}

export interface GitHubProjectPlacementOptions {
  readonly read: (
    request: GitHubProjectMembershipExecution,
  ) => Effect.Effect<string, GitHubReadError>
  readonly write: (
    request: GitHubProjectPlacementExecution,
    onDispatch: () => void,
  ) => Effect.Effect<string, IssuePickupWriteError>
}

const MAX_PLACEMENT_READS = 1000
const MemberSchema = Schema.Struct({
  id: ProjectItemIdSchema,
  isArchived: Schema.Boolean,
  project: Schema.Struct({ id: GitHubInProgressTargetSchema.fields.projectId }),
})
const CursorSchema = Schema.String.pipe(
  Schema.maxLength(4096),
  Schema.filter(value => Buffer.byteLength(value, "utf8") <= 4096),
)
const MembershipSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      nameWithOwner: Schema.String,
      issue: Schema.Struct({
        id: GitHubIssueNodeIdSchema,
        number: Schema.Number.pipe(
          Schema.int(),
          Schema.between(1, 2_147_483_647),
        ),
        repository: Schema.Struct({ nameWithOwner: Schema.String }),
        projectItems: Schema.Struct({
          nodes: Schema.NullOr(
            Schema.Array(Schema.NullOr(MemberSchema)).pipe(
              Schema.maxItems(100),
            ),
          ),
          pageInfo: Schema.Struct({
            hasNextPage: Schema.Boolean,
            endCursor: Schema.NullOr(CursorSchema),
          }),
        }),
      }),
    }),
  }),
})
const AckSchema = Schema.Struct({
  data: Schema.Struct({
    addProjectV2ItemById: Schema.Struct({
      item: Schema.Struct({
        ...MemberSchema.fields,
        content: Schema.Struct({
          id: GitHubIssueNodeIdSchema,
          number: Schema.Number,
          repository: Schema.Struct({ nameWithOwner: Schema.String }),
        }),
      }),
    }),
  }),
})
const readError = (code: GitHubReadError["code"]) =>
  new GitHubReadError({
    code,
    message: "GitHub Project membership could not be established",
  })
const parse = (text: unknown): Either.Either<unknown, GitHubReadError> =>
  Either.gen(function* () {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > MAX_GITHUB_READ_BYTES
    )
      return yield* Either.left(readError("invalid_response"))
    const value = yield* Either.try({
      try: (): unknown => JSON.parse(text),
      catch: () => readError("invalid_response"),
    })
    if (
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, "errors")
    )
      return yield* Either.left(readError("invalid_response"))
    return value
  })

type Member = typeof MemberSchema.Type
type Project = {
  readonly project: GitHubSchedulingProject
  readonly projectId: GitHubInProgressTarget["projectId"]
}

export const createGitHubProjectPlacement = (
  options: GitHubProjectPlacementOptions,
): TaskProjectPlacement => {
  const captured = Either.try({
    try: () => ({ read: options.read, write: options.write }),
    catch: () => readError("transport_error"),
  })
  const placeAffected: TaskProjectPlacement["placeAffected"] = (
    saved,
    invocation,
    observe,
  ) =>
    Effect.gen(function* () {
      const observations = new Map<string, ProjectPlacementObservation>()
      const snapshot = () => Object.freeze([...observations.values()])
      const emit = (observation: ProjectPlacementObservation) => {
        observations.set(
          issueKey(observation.issue),
          Object.freeze(observation),
        )
        observe?.(snapshot())
      }
      let reads = 0
      const scan = (issue: IssueReference, project: Project) =>
        Effect.gen(function* () {
          const ports = yield* captured
          if (issue.number > 2_147_483_647)
            return yield* Effect.fail(readError("invalid_request"))
          const separator = issue.repository.indexOf("/")
          let after: string | null = null
          let identity: GitHubIssueNodeId | undefined
          const cursors = new Set<string>()
          const items = new Set<string>()
          while (true) {
            if (reads >= MAX_PLACEMENT_READS)
              return yield* Effect.fail(readError("capacity"))
            reads += 1
            const response = yield* Effect.suspend(() =>
              ports.read({
                document: GITHUB_PROJECT_MEMBERSHIP_DOCUMENT,
                variables: {
                  owner: issue.repository.slice(0, separator),
                  name: issue.repository.slice(separator + 1),
                  number: issue.number,
                  first: 100,
                  after,
                },
              }),
            ).pipe(
              Effect.mapError(() => readError("transport_error")),
              Effect.catchAllDefect(() =>
                Effect.fail(readError("transport_error")),
              ),
            )
            const payload = yield* parse(response)
            const page = yield* Schema.decodeUnknownEither(MembershipSchema)(
              payload,
            ).pipe(Either.mapLeft(() => readError("invalid_response")))
            const root = page.data.repository
            const actual = yield* decodeIssueReference({
              repository: root.issue.repository.nameWithOwner,
              number: root.issue.number,
            }).pipe(Either.mapLeft(() => readError("invalid_response")))
            const repository = yield* decodeIssueReference({
              repository: root.nameWithOwner,
              number: root.issue.number,
            }).pipe(Either.mapLeft(() => readError("invalid_response")))
            if (
              issueKey(actual) !== issueKey(issue) ||
              issueKey(repository) !== issueKey(issue) ||
              (identity !== undefined && identity !== root.issue.id)
            )
              return yield* Effect.fail(readError("invalid_response"))
            identity = root.issue.id
            const connection = root.issue.projectItems
            if (
              connection.nodes === null ||
              connection.nodes.some(node => node === null)
            )
              return yield* Effect.fail(readError("invalid_response"))
            const nodes = connection.nodes.filter(node => node !== null)
            for (const node of nodes) {
              if (items.has(node.id))
                return yield* Effect.fail(readError("invalid_response"))
              items.add(node.id)
            }
            const member = nodes.find(
              node => node.project.id === project.projectId,
            )
            if (member !== undefined)
              return { issueNodeId: identity, member: Object.freeze(member) }
            if (!connection.pageInfo.hasNextPage)
              return { issueNodeId: identity, member: null }
            const next = connection.pageInfo.endCursor
            if (
              next === null ||
              next.length === 0 ||
              next === after ||
              cursors.has(next)
            )
              return yield* Effect.fail(readError("invalid_response"))
            cursors.add(next)
            after = next
          }
        })
      const linked = (
        issue: IssueReference,
        project: Project,
        member: Member,
        write: "not_needed" | "acknowledged" | "possible",
      ): ProjectPlacementObservation => ({
        kind: "linked",
        issue,
        project: project.project,
        itemId: member.id,
        archived: member.isArchived,
        write,
      })
      const affected = new Map(
        saved.issues.map(row => [issueKey(row.issue), row.issue]),
      )
      for (const issue of affected.values()) {
        const configured = configuredTaskProject(issue.repository)
        if (Either.isLeft(configured)) {
          emit({ kind: "not_attempted", issue, reason: "unavailable" })
          continue
        }
        if (Option.isNone(configured.right)) {
          emit({ kind: "not_attempted", issue, reason: "unsupported_owner" })
          continue
        }
        const project = configured.right.value
        const initial = yield* Effect.either(scan(issue, project))
        if (Either.isLeft(initial)) {
          if (initial.left.code === "capacity")
            emit({ kind: "not_attempted", issue, reason: "budget" })
          else
            emit({
              kind: "failed",
              issue,
              project: project.project,
              reason:
                initial.left.code === "transport_error"
                  ? "transport_error"
                  : initial.left.code === "unavailable"
                    ? "unavailable"
                    : "invalid_response",
            })
          continue
        }
        if (initial.right.member !== null) {
          emit(linked(issue, project, initial.right.member, "not_needed"))
          continue
        }
        if (Either.isLeft(captured)) {
          emit({
            kind: "failed",
            issue,
            project: project.project,
            reason: "transport_error",
          })
          continue
        }
        const ports = captured.right
        let dispatched = false
        const write = yield* Effect.either(
          Effect.suspend(() =>
            ports.write(
              {
                document: GITHUB_PROJECT_PLACEMENT_DOCUMENT,
                variables: {
                  input: {
                    projectId: project.projectId,
                    contentId: initial.right.issueNodeId,
                    clientMutationId: `${invocation.toolCallId}:project:${issueKey(issue)}`,
                  },
                },
              },
              () => {
                dispatched = true
                emit({ kind: "unknown", issue, project: project.project })
              },
            ),
          ).pipe(
            Effect.catchAllDefect(() =>
              Effect.fail(
                new IssuePickupWriteError({
                  dispatch: dispatched ? "possible" : "not_started",
                  message: "Project placement transport failed",
                }),
              ),
            ),
          ),
        )
        if (
          Either.isLeft(write) &&
          !dispatched &&
          write.left.dispatch === "not_started"
        ) {
          emit({
            kind: "failed",
            issue,
            project: project.project,
            reason: "transport_error",
          })
          continue
        }
        emit({ kind: "unknown", issue, project: project.project })
        let writeObservation: "acknowledged" | "possible" = "possible"
        if (Either.isRight(write)) {
          const ack = parse(write.right).pipe(
            Either.flatMap(value =>
              Schema.decodeUnknownEither(AckSchema)(value).pipe(
                Either.mapLeft(() => readError("invalid_response")),
              ),
            ),
          )
          if (Either.isRight(ack)) {
            const item = ack.right.data.addProjectV2ItemById.item
            if (
              item.project.id === project.projectId &&
              item.content.id === initial.right.issueNodeId &&
              item.content.number === issue.number &&
              item.content.repository.nameWithOwner.toLowerCase() ===
                issue.repository
            )
              writeObservation = "acknowledged"
          }
        }
        const reconciled = yield* Effect.either(scan(issue, project))
        if (Either.isRight(reconciled) && reconciled.right.member !== null)
          emit(
            linked(issue, project, reconciled.right.member, writeObservation),
          )
      }
      return snapshot()
    })
  return Object.freeze({ placeAffected })
}
