import { Effect, Either, Schema } from "effect"
import {
  GitHubUserSchema,
  decodeGitHubAssignees,
  type GitHubUser,
} from "./github-user.ts"
import {
  decodeIssueReference,
  issueKey,
  type IssueReference,
} from "./identity.ts"
import {
  GitHubReadError,
  MAX_GITHUB_READ_BYTES,
  type GitHubConnectionPageInfo,
} from "./github-read.ts"

export const MAX_GITHUB_PROJECT_PAGE_SIZE = 100
export const GITHUB_PROJECT_SCHEDULING_DOCUMENT = `query ProjectSchedulingMetadata(
  $project: ID!
  $first: Int!
  $after: String
) {
  viewer { id login }
  node(id: $project) {
    __typename
    ... on ProjectV2 {
      id
      number
      owner {
        __typename
        ... on User { login }
        ... on Organization { login }
      }
      priorityField: field(name: "Priority") { ...SchedulingField }
      effortField: field(name: "Effort") { ...SchedulingField }
      statusField: field(name: "Status") {
        __typename
        ... on ProjectV2SingleSelectField {
          id name dataType options { id name }
        }
      }
      items(first: $first, after: $after, archivedStates: [NOT_ARCHIVED], orderBy: {field: POSITION, direction: ASC}) {
        nodes {
          id
          isArchived
          content {
            __typename
            ... on Issue {
              id number state repository { nameWithOwner }
              assignees(first: 100) {
                nodes { id login }
                totalCount
                pageInfo { hasNextPage endCursor }
              }
            }
          }
          priority: fieldValueByName(name: "Priority") { ...SchedulingNumber }
          effort: fieldValueByName(name: "Effort") { ...SchedulingNumber }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
fragment SchedulingField on ProjectV2FieldConfiguration {
  __typename
  ... on ProjectV2Field {
    id
    name
    dataType
    isIssueField
    issueField { __typename ... on IssueFieldNumber { id } }
  }
}
fragment SchedulingNumber on ProjectV2ItemFieldValue {
  __typename
  ... on ProjectV2ItemFieldNumberValue {
    field { ... on ProjectV2FieldCommon { id } }
    number
  }
  ... on ProjectV2ItemIssueFieldValue {
    field { ... on ProjectV2FieldCommon { id } }
    issueFieldValue {
      __typename
      ... on IssueFieldNumberValue { value }
    }
  }
}`

export type GitHubSchedulingProject = "personal" | "dataclique"
export const ProjectItemIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("GitHubProjectItemId"),
)
export type GitHubProjectItemId = typeof ProjectItemIdSchema.Type

export interface GitHubProjectQuery {
  readonly project: GitHubSchedulingProject
  readonly page: {
    readonly limit: number
    readonly after?: string
  }
}
export interface GitHubProjectQueryExecution {
  readonly document: typeof GITHUB_PROJECT_SCHEDULING_DOCUMENT
  readonly variables: {
    readonly project: string
    readonly first: number
    readonly after: string | null
  }
}
export type GitHubProjectNumberValue =
  | { readonly kind: "unset" }
  | { readonly kind: "number"; readonly value: number }
export type GitHubProjectItem =
  | {
      readonly kind: "issue"
      readonly itemId: GitHubProjectItemId
      readonly issue: IssueReference
      readonly issueNodeId: GitHubIssueNodeId
      readonly assignees: readonly GitHubUser[]
      readonly state: "open" | "closed"
      readonly priority: GitHubProjectNumberValue
      readonly effort: GitHubProjectNumberValue
    }
  | {
      readonly kind: "other"
      readonly itemId: GitHubProjectItemId
      readonly contentType: "PullRequest" | "DraftIssue"
    }
export interface GitHubProjectPage {
  readonly project: GitHubSchedulingProject
  readonly viewer: GitHubUser
  readonly inProgress: GitHubInProgressTarget
  readonly items: readonly GitHubProjectItem[]
  readonly pageInfo: GitHubConnectionPageInfo
}
export interface GitHubProjectReadOptions {
  readonly executeQuery: (
    request: GitHubProjectQueryExecution,
  ) => Effect.Effect<string, GitHubReadError>
}
export interface GitHubProjectReader {
  readonly read: (
    input: unknown,
  ) => Effect.Effect<GitHubProjectPage, GitHubReadError>
}

export const createGitHubProjectReader = (
  options: GitHubProjectReadOptions,
): GitHubProjectReader => {
  const captured = Either.try({
    try: () => options.executeQuery,
    catch: () => projectError("transport_error"),
  })

  return Object.freeze({
    read: (input: unknown) =>
      Effect.gen(function* () {
        yield* Effect.yieldNow()
        const query = yield* decodeGitHubProjectQuery(input)
        const binding = yield* decode(
          ProjectBindingSchema,
          rawBindings[query.project],
        )

        if (Either.isLeft(captured)) return yield* Effect.fail(captured.left)

        const execute = captured.right
        const request: GitHubProjectQueryExecution = Object.freeze({
          document: GITHUB_PROJECT_SCHEDULING_DOCUMENT,
          variables: Object.freeze({
            project: binding.id,
            first: query.page.limit,
            after: query.page.after === undefined ? null : query.page.after,
          }),
        })
        const payload = yield* Effect.suspend(() => execute(request)).pipe(
          Effect.mapError(() => projectError("transport_error")),
          Effect.catchAllDefect(() =>
            Effect.fail(projectError("transport_error")),
          ),
        )

        return yield* decodeGitHubProjectPage(payload, query)
      }),
  })
}

export const decodeGitHubProjectQuery = (
  input: unknown,
): Either.Either<GitHubProjectQuery, GitHubReadError> =>
  Either.try({
    try: () => normalizeQuery(input),
    catch: () => projectError("invalid_request"),
  }).pipe(Either.flatMap(result => result))

export const decodeGitHubProjectPage = (
  payload: unknown,
  suppliedQuery: GitHubProjectQuery,
): Either.Either<GitHubProjectPage, GitHubReadError> =>
  Either.gen(function* () {
    const query = yield* decodeGitHubProjectQuery(suppliedQuery)
    const parsed = yield* decodePayload(payload)
    const envelope = yield* decode(EnvelopeSchema, parsed)
    const project = envelope.data.node

    if (project === null) return yield* invalid("unavailable")

    const binding = yield* decode(
      ProjectBindingSchema,
      rawBindings[query.project],
    )

    if (
      project.id !== binding.id ||
      project.number !== binding.number ||
      project.owner.__typename !== binding.owner.__typename ||
      project.owner.login.toLowerCase() !== binding.owner.login
    )
      return yield* invalid("invalid_response")

    if (
      project.priorityField === null ||
      project.effortField === null ||
      project.statusField === null
    )
      return yield* invalid("unavailable")

    yield* validateField(project.priorityField, "Priority", binding.priority)
    yield* validateField(project.effortField, "Effort", binding.effort)
    const inProgress = yield* decodeGitHubInProgressTarget(
      project.id,
      project.statusField,
    )

    const { nodes, pageInfo } = project.items

    if (nodes === null || nodes.some(node => node === null))
      return yield* invalid("partial_response")
    if (
      nodes.length > query.page.limit ||
      (pageInfo.hasNextPage && pageInfo.endCursor === query.page.after)
    )
      return yield* invalid("invalid_response")

    const items = yield* Either.all(
      nodes.map(node => decodeItem(node, binding)),
    )
    const issues = items.flatMap(item =>
      item.kind === "issue" ? [issueKey(item.issue)] : [],
    )

    if (
      new Set(items.map(item => item.itemId)).size !== items.length ||
      new Set(issues).size !== issues.length
    )
      return yield* invalid("invalid_response")

    return Object.freeze({
      project: query.project,
      viewer: Object.freeze({ ...envelope.data.viewer }),
      inProgress: Object.freeze(inProgress),
      items: Object.freeze(items),
      pageInfo: Object.freeze({ ...pageInfo }),
    })
  })

export const decodeGitHubInProgressTarget = (
  projectId: unknown,
  field: unknown,
): Either.Either<GitHubInProgressTarget, GitHubReadError> =>
  Either.gen(function* () {
    const project = yield* decode(ProjectIdSchema, projectId)
    const alias =
      project === rawBindings.personal.id
        ? "personal"
        : project === rawBindings.dataclique.id
          ? "dataclique"
          : null
    if (alias === null) return yield* invalid("invalid_response")
    const binding = yield* decode(ProjectBindingSchema, rawBindings[alias])
    if (field === null) return yield* invalid("unavailable")
    const status = yield* decode(StatusFieldSchema, field)
    const option = status.options.find(
      value => value.id === binding.status.optionId,
    )
    if (
      status.id !== binding.status.id ||
      status.name !== "Status" ||
      option?.name !== binding.status.optionName ||
      new Set(status.options.map(value => value.id)).size !==
        status.options.length ||
      new Set(status.options.map(value => value.name)).size !==
        status.options.length
    )
      return yield* invalid("invalid_response")
    return yield* decode(GitHubInProgressTargetSchema, {
      projectId: project,
      fieldId: status.id,
      optionId: option.id,
    })
  })

const rawBindings = {
  personal: {
    id: "PVT_kwHOAl_tIc4BpO1U",
    number: 4,
    owner: { __typename: "User", login: "0xgleb" },
    priority: { id: "PVTF_lAHOAl_tIc4BpO1UzhnrZvE", backing: null },
    effort: { id: "PVTF_lAHOAl_tIc4BpO1UzhnrY5k", backing: null },
    status: {
      id: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
      optionId: "47fc9ee4",
      optionName: "In progress",
    },
  },
  dataclique: {
    id: "PVT_kwDOCA_DB84BkDqI",
    number: 12,
    owner: { __typename: "Organization", login: "dataclique" },
    priority: { id: "PVTF_lADOCA_DB84BkDqIzhnrbUw", backing: "IFN_kgDOAu5Mmg" },
    effort: { id: "PVTF_lADOCA_DB84BkDqIzhny3PM", backing: "IFN_kgDOAu7REw" },
    status: {
      id: "PVTSSF_lADOCA_DB84BkDqIzhi1sHA",
      optionId: "47fc9ee4",
      optionName: "In Progress",
    },
  },
} as const

const ProjectIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("GitHubSchedulingProjectId"),
)
const ProjectFieldIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("GitHubSchedulingProjectFieldId"),
)
export const GitHubIssueNodeIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1024),
  Schema.filter(value => !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value)),
  Schema.brand("GitHubIssueNodeId"),
)
export type GitHubIssueNodeId = typeof GitHubIssueNodeIdSchema.Type

const StatusOptionIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("GitHubProjectStatusOptionId"),
)
export const GitHubInProgressTargetSchema = Schema.Struct({
  projectId: ProjectIdSchema,
  fieldId: ProjectFieldIdSchema,
  optionId: StatusOptionIdSchema,
})
export type GitHubInProgressTarget = typeof GitHubInProgressTargetSchema.Type

const StatusBindingSchema = Schema.Struct({
  id: ProjectFieldIdSchema,
  optionId: StatusOptionIdSchema,
  optionName: Schema.String,
})
const IssueFieldIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("GitHubSchedulingIssueFieldId"),
)
const FieldBindingSchema = Schema.Struct({
  id: ProjectFieldIdSchema,
  backing: Schema.NullOr(IssueFieldIdSchema),
})
const ProjectBindingSchema = Schema.Struct({
  id: ProjectIdSchema,
  number: Schema.Number.pipe(Schema.int(), Schema.between(1, 2_147_483_647)),
  owner: Schema.Struct({
    __typename: Schema.Literal("User", "Organization"),
    login: Schema.String.pipe(Schema.minLength(1)),
  }),
  priority: FieldBindingSchema,
  effort: FieldBindingSchema,
  status: StatusBindingSchema,
})
type FieldBinding = typeof FieldBindingSchema.Type
type ProjectBinding = typeof ProjectBindingSchema.Type

const projectError = (code: GitHubReadError["code"]): GitHubReadError =>
  new GitHubReadError({
    code,
    message: {
      invalid_request:
        "Project reads require a selected target and bounded pagination",
      invalid_response:
        "Project response violates the selected scheduling contract",
      remote_error: "GitHub reported a Project query error; data is incomplete",
      transport_error: "GitHub Project transport did not produce a response",
      unavailable: "The selected Project or scheduling field is unavailable",
      partial_response: "GitHub returned unavailable Project item data",
      capacity: "Project response exceeds the local read byte budget",
    }[code],
  })
const invalid = (code: GitHubReadError["code"]) =>
  Either.left(projectError(code))
const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input).pipe(
    Either.mapLeft(() => projectError("invalid_response")),
  )
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

const CursorSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
  Schema.filter(cursor => Buffer.byteLength(cursor, "utf8") <= 4096),
)
const PageInputSchema = Schema.Struct({
  limit: Schema.Number.pipe(
    Schema.int(),
    Schema.between(1, MAX_GITHUB_PROJECT_PAGE_SIZE),
  ),
  after: Schema.optional(CursorSchema),
})
const ProjectSchema = Schema.Literal("personal", "dataclique")
const normalizeQuery = (
  input: unknown,
): Either.Either<GitHubProjectQuery, GitHubReadError> =>
  Either.gen(function* () {
    if (!shape(input, ["project", "page"], ["project", "page"]))
      return yield* invalid("invalid_request")

    const suppliedProject = input.project
    const suppliedPage = input.page

    if (!shape(suppliedPage, ["limit", "after"], ["limit"]))
      return yield* invalid("invalid_request")

    const project = yield* Schema.decodeUnknownEither(ProjectSchema)(
      suppliedProject,
    ).pipe(Either.mapLeft(() => projectError("invalid_request")))
    const page = yield* Schema.decodeUnknownEither(PageInputSchema)(
      suppliedPage,
    ).pipe(Either.mapLeft(() => projectError("invalid_request")))

    return Object.freeze({
      project,
      page: Object.freeze({
        limit: page.limit,
        ...(page.after === undefined ? {} : { after: page.after }),
      }),
    })
  })

const PageInfoSchema = Schema.Union(
  Schema.Struct({
    hasNextPage: Schema.Literal(false),
    endCursor: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    hasNextPage: Schema.Literal(true),
    endCursor: CursorSchema,
  }),
)
const FieldSchema = Schema.Struct({
  __typename: Schema.Literal("ProjectV2Field"),
  id: ProjectFieldIdSchema,
  name: Schema.String,
  dataType: Schema.Literal("NUMBER"),
  isIssueField: Schema.Boolean,
  issueField: Schema.NullOr(
    Schema.Struct({
      __typename: Schema.Literal("IssueFieldNumber"),
      id: IssueFieldIdSchema,
    }),
  ),
})
const StatusFieldSchema = Schema.Struct({
  __typename: Schema.Literal("ProjectV2SingleSelectField"),
  id: ProjectFieldIdSchema,
  name: Schema.String,
  dataType: Schema.Literal("SINGLE_SELECT"),
  options: Schema.Array(
    Schema.Struct({ id: StatusOptionIdSchema, name: Schema.String }),
  ).pipe(Schema.maxItems(100)),
})
const EnvelopeSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: GitHubUserSchema,
    node: Schema.NullOr(
      Schema.Struct({
        __typename: Schema.Literal("ProjectV2"),
        id: ProjectIdSchema,
        number: Schema.Number.pipe(Schema.int()),
        owner: Schema.Struct({
          __typename: Schema.Literal("User", "Organization"),
          login: Schema.String,
        }),
        priorityField: Schema.NullOr(FieldSchema),
        effortField: Schema.NullOr(FieldSchema),
        statusField: Schema.NullOr(StatusFieldSchema),
        items: Schema.Struct({
          nodes: Schema.NullOr(Schema.Array(Schema.Unknown)),
          pageInfo: PageInfoSchema,
        }),
      }),
    ),
  }),
})
const IssueContentSchema = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  id: GitHubIssueNodeIdSchema,
  assignees: Schema.Unknown,
  number: Schema.Number.pipe(Schema.int(), Schema.between(1, 2_147_483_647)),
  state: Schema.Literal("OPEN", "CLOSED"),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
})
const OtherContentSchema = Schema.Struct({
  __typename: Schema.Literal("PullRequest", "DraftIssue"),
})
const ItemSchema = Schema.Struct({
  id: ProjectItemIdSchema,
  isArchived: Schema.Literal(false),
  content: Schema.NullOr(Schema.Union(IssueContentSchema, OtherContentSchema)),
  priority: Schema.Unknown,
  effort: Schema.Unknown,
})
const NumberSchema = Schema.Number.pipe(Schema.finite())
const NumericValueSchema = Schema.Union(
  Schema.Struct({
    __typename: Schema.Literal("ProjectV2ItemFieldNumberValue"),
    field: Schema.Struct({ id: ProjectFieldIdSchema }),
    number: Schema.NullOr(NumberSchema),
  }),
  Schema.Struct({
    __typename: Schema.Literal("ProjectV2ItemIssueFieldValue"),
    field: Schema.Struct({ id: ProjectFieldIdSchema }),
    issueFieldValue: Schema.NullOr(
      Schema.Struct({
        __typename: Schema.Literal("IssueFieldNumberValue"),
        value: NumberSchema,
      }),
    ),
  }),
)

const decodePayload = (
  payload: unknown,
): Either.Either<unknown, GitHubReadError> =>
  Either.gen(function* () {
    if (typeof payload !== "string") return yield* invalid("invalid_response")
    if (Buffer.byteLength(payload, "utf8") > MAX_GITHUB_READ_BYTES)
      return yield* invalid("capacity")

    const parsed = yield* Either.try({
      try: (): unknown => JSON.parse(payload),
      catch: () => projectError("invalid_response"),
    })

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.hasOwn(parsed, "errors")
    ) {
      yield* decode(
        Schema.Struct({
          errors: Schema.Array(Schema.Struct({ message: Schema.String })).pipe(
            Schema.minItems(1),
          ),
        }),
        parsed,
      )
      return yield* invalid("remote_error")
    }

    return parsed
  })

const validateField = (
  field: typeof FieldSchema.Type,
  name: "Priority" | "Effort",
  binding: FieldBinding,
): Either.Either<void, GitHubReadError> =>
  field.id !== binding.id ||
  field.name !== name ||
  field.isIssueField !== (binding.backing !== null) ||
  (binding.backing === null
    ? field.issueField !== null
    : field.issueField?.id !== binding.backing)
    ? invalid("invalid_response")
    : Either.right(undefined)

const decodeNumber = (
  input: unknown,
  binding: FieldBinding,
): Either.Either<GitHubProjectNumberValue, GitHubReadError> =>
  Either.gen(function* () {
    if (input === null) return Object.freeze({ kind: "unset" as const })

    const number = yield* decode(NumericValueSchema, input)

    if (number.field.id !== binding.id)
      return yield* invalid("invalid_response")

    const value =
      number.__typename === "ProjectV2ItemFieldNumberValue"
        ? number.number
        : number.issueFieldValue === null
          ? null
          : number.issueFieldValue.value

    return value === null
      ? Object.freeze({ kind: "unset" as const })
      : Object.freeze({ kind: "number" as const, value })
  })

const decodeItem = (
  input: unknown,
  binding: ProjectBinding,
): Either.Either<GitHubProjectItem, GitHubReadError> =>
  Either.gen(function* () {
    const item = yield* decode(ItemSchema, input)
    const content = item.content

    if (content === null) return yield* invalid("partial_response")
    if (content.__typename !== "Issue")
      return Object.freeze({
        kind: "other" as const,
        itemId: item.id,
        contentType: content.__typename,
      })

    const issue = yield* decodeIssueReference({
      repository: content.repository.nameWithOwner,
      number: content.number,
    }).pipe(Either.mapLeft(() => projectError("invalid_response")))
    const priority = yield* decodeNumber(item.priority, binding.priority)
    const effort = yield* decodeNumber(item.effort, binding.effort)
    const assignees = yield* decodeGitHubAssignees(content.assignees)

    return Object.freeze({
      kind: "issue" as const,
      itemId: item.id,
      issue,
      issueNodeId: content.id,
      assignees: Object.freeze(
        assignees.map(value => Object.freeze({ ...value })),
      ),
      state: content.state === "OPEN" ? ("open" as const) : ("closed" as const),
      priority,
      effort,
    })
  })
