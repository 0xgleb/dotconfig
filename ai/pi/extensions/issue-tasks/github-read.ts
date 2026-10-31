import { Data, Effect, Either, Schema } from "effect"
import {
  decodeIssueReference,
  decodeIssueRepository,
  issueKey,
  type IssueReference,
  type IssueRepository,
  type PlanInputError,
} from "./identity.ts"

export const MAX_GITHUB_READ_BYTES = 1_048_576
export const MAX_GITHUB_ISSUE_PAGE_SIZE = 100

export const GITHUB_ISSUE_LIST_DOCUMENT = `query IssueBacklogList(
  $owner: String!
  $name: String!
  $first: Int!
  $after: String
  $states: [IssueState!]
) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(first: $first, after: $after, states: $states) {
      nodes {
        number
        title
        url
        state
        updatedAt
        repository { nameWithOwner }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

export const GITHUB_ISSUE_GET_DOCUMENT = `query IssueBacklogGet(
  $owner: String!
  $name: String!
  $number: Int!
  $relatedFirst: Int!
  $blockedByAfter: String
  $deliveryAfter: String
) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      number
      title
      url
      state
      updatedAt
      body
      repository { nameWithOwner }
      parent { number url repository { nameWithOwner } }
      blockedBy(first: $relatedFirst, after: $blockedByAfter) {
        nodes { number url repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
      closedByPullRequestsReferences(first: $relatedFirst, after: $deliveryAfter, includeClosedPrs: true) {
        nodes { number url state repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

export interface GitHubIssueGetExecution {
  readonly document: typeof GITHUB_ISSUE_GET_DOCUMENT
  readonly variables: {
    readonly owner: string
    readonly name: string
    readonly number: number
    readonly relatedFirst: number
    readonly blockedByAfter: string | null
    readonly deliveryAfter: string | null
  }
}
export interface GitHubIssueListExecution {
  readonly document: typeof GITHUB_ISSUE_LIST_DOCUMENT
  readonly variables: {
    readonly owner: string
    readonly name: string
    readonly first: number
    readonly after: string | null
    readonly states: readonly ("OPEN" | "CLOSED")[]
  }
}
export type GitHubIssueQueryExecution =
  GitHubIssueListExecution | GitHubIssueGetExecution
export interface GitHubIssueReadOptions {
  readonly executeQuery: (
    request: GitHubIssueQueryExecution,
  ) => Effect.Effect<string, GitHubReadError>
}
export interface GitHubIssueReader {
  readonly get: (
    input: unknown,
  ) => Effect.Effect<GitHubIssueGetResult, GitHubReadError>
  readonly list: (
    input: unknown,
  ) => Effect.Effect<GitHubIssueListPage, GitHubReadError | PlanInputError>
}

export const createGitHubIssueReader = (
  options: GitHubIssueReadOptions,
): GitHubIssueReader => {
  const execute = (request: GitHubIssueQueryExecution) =>
    Effect.suspend(() => options.executeQuery(request)).pipe(
      Effect.mapError(() => readError("transport_error")),
      Effect.catchAllDefect(() => Effect.fail(readError("transport_error"))),
    )

  return {
    get: input =>
      Effect.gen(function* () {
        yield* Effect.yieldNow()
        const decoded = decodeGitHubIssueGetQuery(input)

        if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left)

        const query = decoded.right
        const separator = query.issue.repository.indexOf("/")

        if (separator < 1)
          return yield* Effect.fail(readError("invalid_request"))

        const request: GitHubIssueGetExecution = Object.freeze({
          document: GITHUB_ISSUE_GET_DOCUMENT,
          variables: Object.freeze({
            owner: query.issue.repository.slice(0, separator),
            name: query.issue.repository.slice(separator + 1),
            number: query.issue.number,
            relatedFirst: query.related.limit,
            blockedByAfter:
              query.related.blockedByAfter === undefined
                ? null
                : query.related.blockedByAfter,
            deliveryAfter:
              query.related.deliveryAfter === undefined
                ? null
                : query.related.deliveryAfter,
          }),
        })
        const payload = yield* execute(request)
        const result = decodeGitHubIssueGetResult(payload, query)

        if (Either.isLeft(result)) return yield* Effect.fail(result.left)

        return result.right
      }),
    list: input =>
      Effect.gen(function* () {
        yield* Effect.yieldNow()

        const decoded = decodeGitHubIssueListQuery(input)

        if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left)

        const query = decoded.right
        const separator = query.repository.indexOf("/")

        if (separator < 1)
          return yield* Effect.fail(readError("invalid_request"))

        const states: readonly ("OPEN" | "CLOSED")[] = Object.freeze(
          query.state === "all"
            ? ["OPEN", "CLOSED"]
            : [query.state === "open" ? "OPEN" : "CLOSED"],
        )
        const request: GitHubIssueListExecution = Object.freeze({
          document: GITHUB_ISSUE_LIST_DOCUMENT,
          variables: Object.freeze({
            owner: query.repository.slice(0, separator),
            name: query.repository.slice(separator + 1),
            first: query.page.limit,
            after: query.page.after === undefined ? null : query.page.after,
            states,
          }),
        })

        const payload = yield* execute(request)
        const page = decodeGitHubIssueListPage(payload, query)

        if (Either.isLeft(page)) return yield* Effect.fail(page.left)

        return page.right
      }),
  }
}

export interface GitHubIssueListQuery {
  readonly repository: IssueRepository
  readonly state: "open" | "closed" | "all"
  readonly page: {
    readonly limit: number
    readonly after?: string
  }
}
export interface GitHubIssueSummary {
  readonly issue: IssueReference
  readonly title: string
  readonly url: string
  readonly state: "open" | "closed"
  readonly updatedAt: string
}
export interface GitHubIssueListPage {
  readonly repository: IssueRepository
  readonly issues: readonly GitHubIssueSummary[]
  readonly pageInfo:
    | { readonly hasNextPage: false; readonly endCursor: string | null }
    | { readonly hasNextPage: true; readonly endCursor: string }
}
export type GitHubConnectionPageInfo = GitHubIssueListPage["pageInfo"]
const GitHubPullRequestNumberSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 2_147_483_647),
  Schema.brand("GitHubPullRequestNumber"),
)
export type GitHubPullRequestNumber = typeof GitHubPullRequestNumberSchema.Type
export interface GitHubPullRequestReference {
  readonly repository: IssueRepository
  readonly number: GitHubPullRequestNumber
  readonly url: string
  readonly state: "open" | "closed" | "merged"
}
export interface GitHubIssueGetQuery {
  readonly issue: IssueReference
  readonly related: {
    readonly limit: number
    readonly blockedByAfter?: string
    readonly deliveryAfter?: string
  }
}
export interface GitHubIssueDetail extends GitHubIssueSummary {
  readonly body: string
  readonly parent: IssueReference | null
  readonly blockedBy: {
    readonly issues: readonly IssueReference[]
    readonly pageInfo: GitHubConnectionPageInfo
  }
  readonly delivery: {
    readonly pullRequests: readonly GitHubPullRequestReference[]
    readonly pageInfo: GitHubConnectionPageInfo
  }
}
export interface GitHubIssueGetResult {
  readonly issue: IssueReference
  readonly detail: GitHubIssueDetail | null
}

export class GitHubReadError extends Data.TaggedError("GitHubReadError")<{
  readonly code:
    | "invalid_request"
    | "invalid_response"
    | "remote_error"
    | "transport_error"
    | "unavailable"
    | "partial_response"
    | "capacity"
  readonly message: string
}> {}

const readError = (code: GitHubReadError["code"]): GitHubReadError =>
  new GitHubReadError({
    code,
    message: {
      invalid_request:
        "GitHub issue reads require explicit targets and bounded pagination",
      invalid_response:
        "GitHub issue response violates the requested page contract",
      remote_error:
        "GitHub reported a query error; response data is not complete readback",
      transport_error: "GitHub query transport did not produce a response",
      unavailable: "The requested GitHub repository is unavailable",
      partial_response: "GitHub returned unavailable requested data",
      capacity: "GitHub response exceeds the local read byte budget",
    }[code],
  })
const invalid = (code: GitHubReadError["code"]) => Either.left(readError(code))
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
const decode = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
  code: GitHubReadError["code"],
) =>
  Schema.decodeUnknownEither(schema)(input).pipe(
    Either.mapLeft(() => readError(code)),
  )

const StateSchema = Schema.Literal("open", "closed", "all")
const PageInputSchema = Schema.Struct({
  limit: Schema.Number.pipe(
    Schema.int(),
    Schema.between(1, MAX_GITHUB_ISSUE_PAGE_SIZE),
  ),
  after: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
})
const PageInfoSchema = Schema.Union(
  Schema.Struct({
    hasNextPage: Schema.Literal(false),
    endCursor: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    hasNextPage: Schema.Literal(true),
    endCursor: Schema.String.pipe(Schema.minLength(1)),
  }),
)
const EnvelopeSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
        issues: Schema.Struct({
          nodes: Schema.NullOr(Schema.Array(Schema.Unknown)),
          pageInfo: PageInfoSchema,
        }),
      }),
    ),
  }),
})
const QueryErrorsSchema = Schema.Array(
  Schema.Struct({ message: Schema.String }),
).pipe(Schema.minItems(1))
const IssueRowSchema = Schema.Struct({
  number: Schema.Number.pipe(Schema.int(), Schema.between(1, 2_147_483_647)),
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literal("OPEN", "CLOSED"),
  updatedAt: Schema.String,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
})

const RelatedInputSchema = Schema.Struct({
  limit: PageInputSchema.fields.limit,
  blockedByAfter: PageInputSchema.fields.after,
  deliveryAfter: PageInputSchema.fields.after,
})
const IssueReferenceRowSchema = Schema.Struct({
  number: IssueRowSchema.fields.number,
  url: Schema.String,
  repository: IssueRowSchema.fields.repository,
})
const PullRequestRowSchema = Schema.Struct({
  number: GitHubPullRequestNumberSchema,
  url: Schema.String,
  state: Schema.Literal("OPEN", "CLOSED", "MERGED"),
  repository: IssueRowSchema.fields.repository,
})
const RelationConnectionSchema = Schema.Struct({
  nodes: Schema.NullOr(Schema.Array(Schema.Unknown)),
  pageInfo: PageInfoSchema,
})
const GetEnvelopeSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
        issue: Schema.NullOr(Schema.Unknown),
      }),
    ),
  }),
})
const DetailRowSchema = Schema.Struct({
  ...IssueRowSchema.fields,
  body: Schema.String,
  parent: Schema.NullOr(IssueReferenceRowSchema),
  blockedBy: RelationConnectionSchema,
  closedByPullRequestsReferences: Schema.NullOr(RelationConnectionSchema),
})
const decodeReadPayload = (
  payload: unknown,
): Either.Either<unknown, GitHubReadError> =>
  Either.gen(function* () {
    if (typeof payload !== "string") return yield* invalid("invalid_response")
    if (Buffer.byteLength(payload, "utf8") > MAX_GITHUB_READ_BYTES)
      return yield* invalid("capacity")

    const parsed = yield* Either.try({
      try: (): unknown => JSON.parse(payload),
      catch: () => readError("invalid_response"),
    })

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.hasOwn(parsed, "errors")
    ) {
      yield* decode(
        Schema.Struct({ errors: QueryErrorsSchema }),
        parsed,
        "invalid_response",
      )
      return yield* invalid("remote_error")
    }

    return parsed
  })
const decodeIssueReferenceRow = (
  input: unknown,
): Either.Either<IssueReference, GitHubReadError> =>
  Either.gen(function* () {
    const row = yield* decode(
      IssueReferenceRowSchema,
      input,
      "invalid_response",
    )
    const issue = yield* decodeIssueReference({
      repository: row.repository.nameWithOwner,
      number: row.number,
    }).pipe(Either.mapLeft(() => readError("invalid_response")))

    if (
      row.url.toLowerCase() !==
      `https://github.com/${issue.repository}/issues/${issue.number}`
    )
      return yield* invalid("invalid_response")

    return issue
  })
const decodeIssueSummary = (
  input: unknown,
): Either.Either<GitHubIssueSummary, GitHubReadError> =>
  Either.gen(function* () {
    const row = yield* decode(IssueRowSchema, input, "invalid_response")
    const issue = yield* decodeIssueReferenceRow(row)

    return Object.freeze({
      issue,
      title: row.title,
      url: row.url,
      state: row.state === "OPEN" ? "open" : "closed",
      updatedAt: row.updatedAt,
    })
  })
const decodePullRequestRow = (
  input: unknown,
): Either.Either<GitHubPullRequestReference, GitHubReadError> =>
  Either.gen(function* () {
    const row = yield* decode(PullRequestRowSchema, input, "invalid_response")
    const repository = yield* decodeIssueRepository(
      row.repository.nameWithOwner,
    ).pipe(Either.mapLeft(() => readError("invalid_response")))

    if (
      row.url.toLowerCase() !==
      `https://github.com/${repository}/pull/${row.number}`
    )
      return yield* invalid("invalid_response")

    return Object.freeze({
      repository,
      number: row.number,
      url: row.url,
      state:
        row.state === "OPEN"
          ? "open"
          : row.state === "CLOSED"
            ? "closed"
            : "merged",
    })
  })

export const decodeGitHubIssueGetQuery = (
  input: unknown,
): Either.Either<GitHubIssueGetQuery, GitHubReadError> =>
  Either.gen(function* () {
    if (
      !shape(input, ["issue", "related"], ["issue", "related"]) ||
      !shape(input.issue, ["repository", "number"], ["repository", "number"]) ||
      !shape(
        input.related,
        ["limit", "blockedByAfter", "deliveryAfter"],
        ["limit"],
      )
    )
      return yield* invalid("invalid_request")

    const issue = yield* decodeIssueReference(input.issue).pipe(
      Either.mapLeft(() => readError("invalid_request")),
    )
    yield* decode(IssueRowSchema.fields.number, issue.number, "invalid_request")
    const related = yield* decode(
      RelatedInputSchema,
      input.related,
      "invalid_request",
    )

    if (
      [related.blockedByAfter, related.deliveryAfter].some(
        cursor =>
          cursor !== undefined &&
          Buffer.byteLength(cursor, "utf8") > MAX_GITHUB_READ_BYTES,
      )
    )
      return yield* invalid("invalid_request")

    return Object.freeze({
      issue,
      related: Object.freeze({
        limit: related.limit,
        ...(related.blockedByAfter === undefined
          ? {}
          : { blockedByAfter: related.blockedByAfter }),
        ...(related.deliveryAfter === undefined
          ? {}
          : { deliveryAfter: related.deliveryAfter }),
      }),
    })
  })

export const decodeGitHubIssueGetResult = (
  payload: unknown,
  suppliedQuery: GitHubIssueGetQuery,
): Either.Either<GitHubIssueGetResult, GitHubReadError> =>
  Either.gen(function* () {
    const query = yield* decodeGitHubIssueGetQuery(suppliedQuery)
    const parsed = yield* decodeReadPayload(payload)
    const envelope = yield* decode(
      GetEnvelopeSchema,
      parsed,
      "invalid_response",
    )
    const repository = envelope.data.repository

    if (repository === null)
      return Object.freeze({ issue: query.issue, detail: null })

    const owner = yield* decodeIssueRepository(repository.nameWithOwner).pipe(
      Either.mapLeft(() => readError("invalid_response")),
    )

    if (owner !== query.issue.repository)
      return yield* invalid("invalid_response")
    if (repository.issue === null)
      return Object.freeze({ issue: query.issue, detail: null })

    const row = yield* decode(
      DetailRowSchema,
      repository.issue,
      "invalid_response",
    )
    const summary = yield* decodeIssueSummary(row)

    if (issueKey(summary.issue) !== issueKey(query.issue))
      return yield* invalid("invalid_response")

    const blockedBy = row.blockedBy
    const delivery = row.closedByPullRequestsReferences

    if (
      blockedBy.nodes === null ||
      delivery === null ||
      delivery.nodes === null ||
      blockedBy.nodes.some(node => node === null) ||
      delivery.nodes.some(node => node === null)
    )
      return yield* invalid("partial_response")
    if (
      blockedBy.nodes.length > query.related.limit ||
      delivery.nodes.length > query.related.limit ||
      (blockedBy.pageInfo.hasNextPage &&
        blockedBy.pageInfo.endCursor === query.related.blockedByAfter) ||
      (delivery.pageInfo.hasNextPage &&
        delivery.pageInfo.endCursor === query.related.deliveryAfter)
    )
      return yield* invalid("invalid_response")

    const parent =
      row.parent === null ? null : yield* decodeIssueReferenceRow(row.parent)
    const issues = yield* Either.all(
      blockedBy.nodes.map(decodeIssueReferenceRow),
    )
    const pullRequests = yield* Either.all(
      delivery.nodes.map(decodePullRequestRow),
    )

    if (
      new Set(issues.map(issueKey)).size !== issues.length ||
      new Set(pullRequests.map(pr => `${pr.repository}#${pr.number}`)).size !==
        pullRequests.length
    )
      return yield* invalid("invalid_response")

    return Object.freeze({
      issue: query.issue,
      detail: Object.freeze({
        ...summary,
        body: row.body,
        parent,
        blockedBy: Object.freeze({
          issues: Object.freeze(issues),
          pageInfo: Object.freeze({ ...blockedBy.pageInfo }),
        }),
        delivery: Object.freeze({
          pullRequests: Object.freeze(pullRequests),
          pageInfo: Object.freeze({ ...delivery.pageInfo }),
        }),
      }),
    })
  })

export const decodeGitHubIssueListQuery = (
  input: unknown,
): Either.Either<GitHubIssueListQuery, GitHubReadError | PlanInputError> =>
  Either.gen(function* () {
    if (
      !shape(
        input,
        ["repository", "state", "page"],
        ["repository", "state", "page"],
      ) ||
      !shape(input.page, ["limit", "after"], ["limit"])
    )
      return yield* invalid("invalid_request")

    const repository = yield* decodeIssueRepository(input.repository)
    const state = yield* decode(StateSchema, input.state, "invalid_request")
    const page = yield* decode(PageInputSchema, input.page, "invalid_request")

    if (
      page.after !== undefined &&
      Buffer.byteLength(page.after, "utf8") > MAX_GITHUB_READ_BYTES
    )
      return yield* invalid("invalid_request")

    return Object.freeze({
      repository,
      state,
      page: Object.freeze({
        limit: page.limit,
        ...(page.after === undefined ? {} : { after: page.after }),
      }),
    })
  })

export const decodeGitHubIssueListPage = (
  payload: unknown,
  suppliedQuery: GitHubIssueListQuery,
): Either.Either<GitHubIssueListPage, GitHubReadError | PlanInputError> =>
  Either.gen(function* () {
    const query = yield* decodeGitHubIssueListQuery(suppliedQuery)
    const parsed = yield* decodeReadPayload(payload)
    const envelope = yield* decode(EnvelopeSchema, parsed, "invalid_response")
    const repository = envelope.data.repository

    if (repository === null) return yield* invalid("unavailable")

    const owner = yield* decodeIssueRepository(repository.nameWithOwner).pipe(
      Either.mapLeft(() => readError("invalid_response")),
    )

    if (owner !== query.repository) return yield* invalid("invalid_response")

    const { nodes, pageInfo } = repository.issues

    if (nodes === null || nodes.some(node => node === null))
      return yield* invalid("partial_response")

    if (
      nodes.length > query.page.limit ||
      (pageInfo.hasNextPage && pageInfo.endCursor === query.page.after)
    )
      return yield* invalid("invalid_response")

    const issues = yield* Either.all(nodes.map(decodeIssueSummary))

    if (
      issues.some(
        row =>
          row.issue.repository !== query.repository ||
          (query.state !== "all" && row.state !== query.state),
      )
    )
      return yield* invalid("invalid_response")
    if (new Set(issues.map(row => issueKey(row.issue))).size !== issues.length)
      return yield* invalid("invalid_response")

    return Object.freeze({
      repository: owner,
      issues: Object.freeze(issues),
      pageInfo: Object.freeze({ ...pageInfo }),
    })
  })
