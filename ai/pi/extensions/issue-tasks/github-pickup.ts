import { Effect, Either, Schema } from "effect"
import { MAX_GITHUB_READ_BYTES, type GitHubReadError } from "./github-read.ts"
import { decodeIssueReference, issueKey } from "./identity.ts"
import { GitHubUserSchema, decodeGitHubAssignees } from "./github-user.ts"
import {
  GitHubInProgressTargetSchema,
  GitHubIssueNodeIdSchema,
  ProjectItemIdSchema,
  decodeGitHubInProgressTarget,
} from "./github-project-read.ts"
import {
  IssuePickupReadError,
  IssuePickupWriteError,
  type IssuePickupClient,
  type IssuePickupTarget,
  type IssuePickupObservation,
} from "./pickup.ts"
import type { GitHubUserIdSchema } from "./github-user.ts"
import type {
  GitHubInProgressTarget,
  GitHubIssueNodeId,
  GitHubProjectItemId,
} from "./github-project-read.ts"

/**
 * GitHub GraphQL contracts: ProjectV2Item, AddAssigneesToAssignableInput,
 * and UpdateProjectV2ItemFieldValueInput.
 * https://docs.github.com/en/graphql/reference
 *
 * addAssigneesToAssignable adds assignees; it does not replace the list or
 * condition the write on earlier observations. Status is a separate mutation.
 */
export const GITHUB_PICKUP_READ_DOCUMENT = `query TaskPickupRead($item: ID!) {
  viewer { id login }
  node(id: $item) {
    __typename
    ... on ProjectV2Item {
      id isArchived
      project {
        id
        statusField: field(name: "Status") {
          __typename
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
      }
      content {
        __typename
        ... on Issue {
          id number state repository { nameWithOwner }
          assignees(first: 100) { nodes { id login } totalCount pageInfo { hasNextPage endCursor } }
        }
      }
      status: fieldValueByName(name: "Status") {
        __typename
        ... on ProjectV2ItemFieldSingleSelectValue {
          optionId
          field { ... on ProjectV2SingleSelectField { id } }
        }
      }
    }
  }
}`

export const GITHUB_PICKUP_ASSIGN_DOCUMENT = `mutation TaskPickupAssign($input: AddAssigneesToAssignableInput!) {
  addAssigneesToAssignable(input: $input) { assignable { ... on Issue { id } } }
}`

export const GITHUB_PICKUP_STATUS_DOCUMENT = `mutation TaskPickupStatus($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`

export interface GitHubPickupReadExecution {
  readonly document: typeof GITHUB_PICKUP_READ_DOCUMENT
  readonly variables: { readonly item: GitHubProjectItemId }
}

export type GitHubPickupWriteExecution =
  | {
      readonly document: typeof GITHUB_PICKUP_ASSIGN_DOCUMENT
      readonly variables: {
        readonly input: {
          readonly assignableId: GitHubIssueNodeId
          readonly assigneeIds: readonly (typeof GitHubUserIdSchema.Type)[]
          readonly clientMutationId: string
        }
      }
    }
  | {
      readonly document: typeof GITHUB_PICKUP_STATUS_DOCUMENT
      readonly variables: {
        readonly input: {
          readonly projectId: GitHubInProgressTarget["projectId"]
          readonly itemId: GitHubProjectItemId
          readonly fieldId: GitHubInProgressTarget["fieldId"]
          readonly value: {
            readonly singleSelectOptionId: GitHubInProgressTarget["optionId"]
          }
          readonly clientMutationId: string
        }
      }
    }

export interface GitHubPickupOptions {
  readonly read: (
    request: GitHubPickupReadExecution,
  ) => Effect.Effect<string, GitHubReadError>
  readonly write: (
    request: GitHubPickupWriteExecution,
    onDispatch: () => void,
  ) => Effect.Effect<string, IssuePickupWriteError>
}

const readError = (code: IssuePickupReadError["code"]) =>
  new IssuePickupReadError({
    code,
    message: "GitHub did not provide a complete matching pickup observation",
  })
const writeError = (dispatch: IssuePickupWriteError["dispatch"]) =>
  new IssuePickupWriteError({
    dispatch,
    message:
      dispatch === "possible"
        ? "Pickup write may have been dispatched; reconcile observed state"
        : "Pickup write was not dispatched",
  })
const TargetSchema = Schema.Struct({
  issue: Schema.Unknown,
  issueNodeId: GitHubIssueNodeIdSchema,
  itemId: ProjectItemIdSchema,
  viewer: GitHubUserSchema,
  inProgress: GitHubInProgressTargetSchema,
})
const decodeTarget = (
  input: unknown,
): Either.Either<IssuePickupTarget, IssuePickupReadError> =>
  Either.gen(function* () {
    const raw = yield* Schema.decodeUnknownEither(TargetSchema)(input).pipe(
      Either.mapLeft(() => readError("invalid_request")),
    )
    const issue = yield* decodeIssueReference(raw.issue).pipe(
      Either.mapLeft(() => readError("invalid_request")),
    )
    return Object.freeze({
      ...raw,
      issue,
      viewer: Object.freeze({ ...raw.viewer }),
      inProgress: Object.freeze({ ...raw.inProgress }),
    })
  })
const StatusSchema = Schema.Struct({
  __typename: Schema.Literal("ProjectV2ItemFieldSingleSelectValue"),
  optionId: GitHubInProgressTargetSchema.fields.optionId,
  field: Schema.Struct({ id: GitHubInProgressTargetSchema.fields.fieldId }),
})
const ObservationSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: GitHubUserSchema,
    node: Schema.Struct({
      __typename: Schema.Literal("ProjectV2Item"),
      id: ProjectItemIdSchema,
      isArchived: Schema.Boolean,
      project: Schema.Struct({
        id: GitHubInProgressTargetSchema.fields.projectId,
        statusField: Schema.Unknown,
      }),
      content: Schema.Struct({
        __typename: Schema.Literal("Issue"),
        id: GitHubIssueNodeIdSchema,
        number: Schema.Number.pipe(
          Schema.int(),
          Schema.between(1, 2_147_483_647),
        ),
        state: Schema.Literal("OPEN", "CLOSED"),
        repository: Schema.Struct({ nameWithOwner: Schema.String }),
        assignees: Schema.Unknown,
      }),
      status: Schema.NullOr(StatusSchema),
    }),
  }),
})
const parse = (text: unknown): Either.Either<unknown, IssuePickupReadError> =>
  Either.gen(function* () {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > MAX_GITHUB_READ_BYTES
    )
      return yield* Either.left(readError("invalid_response"))
    const payload = yield* Either.try({
      try: (): unknown => JSON.parse(text),
      catch: () => readError("invalid_response"),
    })
    if (
      typeof payload === "object" &&
      payload !== null &&
      Object.hasOwn(payload, "errors")
    )
      return yield* Either.left(readError("invalid_response"))
    return payload
  })
const decodeObservation = (
  text: unknown,
  target: IssuePickupTarget,
): Either.Either<IssuePickupObservation, IssuePickupReadError> =>
  Either.gen(function* () {
    const payload = yield* parse(text)
    const response = yield* Schema.decodeUnknownEither(ObservationSchema)(
      payload,
    ).pipe(Either.mapLeft(() => readError("invalid_response")))
    const { viewer, node } = response.data
    const issue = yield* decodeIssueReference({
      repository: node.content.repository.nameWithOwner,
      number: node.content.number,
    }).pipe(Either.mapLeft(() => readError("invalid_response")))
    const actual = yield* decodeGitHubInProgressTarget(
      node.project.id,
      node.project.statusField,
    ).pipe(Either.mapLeft(() => readError("invalid_response")))
    if (
      node.id !== target.itemId ||
      node.content.id !== target.issueNodeId ||
      issueKey(issue) !== issueKey(target.issue) ||
      actual.projectId !== target.inProgress.projectId ||
      actual.fieldId !== target.inProgress.fieldId ||
      actual.optionId !== target.inProgress.optionId ||
      (node.status !== null && node.status.field.id !== actual.fieldId)
    )
      return yield* Either.left(readError("invalid_response"))
    const assignees = yield* decodeGitHubAssignees(node.content.assignees).pipe(
      Either.mapLeft(() => readError("invalid_response")),
    )
    return Object.freeze({
      viewer: Object.freeze({ ...viewer }),
      issue,
      issueNodeId: node.content.id,
      itemId: node.id,
      projectId: actual.projectId,
      state: node.content.state === "OPEN" ? "open" : "closed",
      archived: node.isArchived,
      assignees,
      status:
        node.status === null
          ? null
          : Object.freeze({
              fieldId: node.status.field.id,
              optionId: node.status.optionId,
            }),
    })
  })
const AssignResponseSchema = Schema.Struct({
  data: Schema.Struct({
    addAssigneesToAssignable: Schema.Struct({
      assignable: Schema.Struct({ id: GitHubIssueNodeIdSchema }),
    }),
  }),
})
const StatusResponseSchema = Schema.Struct({
  data: Schema.Struct({
    updateProjectV2ItemFieldValue: Schema.Struct({
      projectV2Item: Schema.Struct({ id: ProjectItemIdSchema }),
    }),
  }),
})

export const createGitHubPickupClient = (
  options: GitHubPickupOptions,
): IssuePickupClient => {
  const captured = Either.try({
    try: () => ({ read: options.read, write: options.write }),
    catch: () => readError("unavailable"),
  })
  const write = (request: GitHubPickupWriteExecution, onDispatch: () => void) =>
    Effect.gen(function* () {
      const ports = yield* captured.pipe(
        Either.mapLeft(() => writeError("not_started")),
      )
      let dispatched = false
      const response = yield* Effect.suspend(() =>
        ports.write(request, () => {
          dispatched = true
          onDispatch()
        }),
      ).pipe(
        Effect.mapError(error =>
          writeError(
            dispatched || error.dispatch === "possible"
              ? "possible"
              : "not_started",
          ),
        ),
        Effect.catchAllDefect(() =>
          Effect.fail(writeError(dispatched ? "possible" : "not_started")),
        ),
      )
      const payload = yield* parse(response).pipe(
        Either.mapLeft(() => writeError("possible")),
      )
      if (request.document === GITHUB_PICKUP_ASSIGN_DOCUMENT) {
        const decoded = yield* Schema.decodeUnknownEither(AssignResponseSchema)(
          payload,
        ).pipe(Either.mapLeft(() => writeError("possible")))
        if (
          decoded.data.addAssigneesToAssignable.assignable.id !==
          request.variables.input.assignableId
        )
          return yield* Effect.fail(writeError("possible"))
      } else {
        const decoded = yield* Schema.decodeUnknownEither(StatusResponseSchema)(
          payload,
        ).pipe(Either.mapLeft(() => writeError("possible")))
        if (
          decoded.data.updateProjectV2ItemFieldValue.projectV2Item.id !==
          request.variables.input.itemId
        )
          return yield* Effect.fail(writeError("possible"))
      }
    })

  const client: IssuePickupClient = {
    inspect: (supplied: IssuePickupTarget) =>
      Effect.gen(function* () {
        yield* Effect.yieldNow()
        const target = yield* decodeTarget(supplied)
        const ports = yield* captured
        const response = yield* Effect.suspend(() =>
          ports.read(
            Object.freeze({
              document: GITHUB_PICKUP_READ_DOCUMENT,
              variables: Object.freeze({ item: target.itemId }),
            }),
          ),
        ).pipe(
          Effect.mapError(() => readError("transport_error")),
          Effect.catchAllDefect(() =>
            Effect.fail(readError("transport_error")),
          ),
        )
        return yield* decodeObservation(response, target)
      }),
    assignOwner: (supplied, invocation, onDispatch) =>
      Effect.gen(function* () {
        const target = yield* decodeTarget(supplied).pipe(
          Either.mapLeft(() => writeError("not_started")),
        )
        return yield* write(
          {
            document: GITHUB_PICKUP_ASSIGN_DOCUMENT,
            variables: {
              input: {
                assignableId: target.issueNodeId,
                assigneeIds: [target.viewer.id],
                clientMutationId: `${invocation.toolCallId}:assign`,
              },
            },
          },
          onDispatch,
        )
      }),
    setInProgress: (supplied, invocation, onDispatch) =>
      Effect.gen(function* () {
        const target = yield* decodeTarget(supplied).pipe(
          Either.mapLeft(() => writeError("not_started")),
        )
        return yield* write(
          {
            document: GITHUB_PICKUP_STATUS_DOCUMENT,
            variables: {
              input: {
                projectId: target.inProgress.projectId,
                itemId: target.itemId,
                fieldId: target.inProgress.fieldId,
                value: { singleSelectOptionId: target.inProgress.optionId },
                clientMutationId: `${invocation.toolCallId}:status`,
              },
            },
          },
          onDispatch,
        )
      }),
  }

  return Object.freeze(client)
}
