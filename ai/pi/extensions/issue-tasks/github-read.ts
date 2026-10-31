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
export interface GitHubIssueReadOptions {
  readonly executeQuery: (
    request: GitHubIssueListExecution,
  ) => Effect.Effect<string, GitHubReadError>
}
export interface GitHubIssueReader {
  readonly list: (
    input: unknown,
  ) => Effect.Effect<GitHubIssueListPage, GitHubReadError | PlanInputError>
}

export const createGitHubIssueReader = (
  options: GitHubIssueReadOptions,
): GitHubIssueReader => ({
  list: input =>
    Effect.gen(function* () {
      yield* Effect.yieldNow()

      const decoded = decodeGitHubIssueListQuery(input)

      if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left)

      const query = decoded.right
      const separator = query.repository.indexOf("/")

      if (separator < 1) return yield* Effect.fail(readError("invalid_request"))

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

      const payload = yield* Effect.suspend(() =>
        options.executeQuery(request),
      ).pipe(
        Effect.mapError(() => readError("transport_error")),
        Effect.catchAllDefect(() => Effect.fail(readError("transport_error"))),
      )
      const page = decodeGitHubIssueListPage(payload, query)

      if (Either.isLeft(page)) return yield* Effect.fail(page.left)

      return page.right
    }),
})

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
        "Issue discovery requires explicit repository, state and bounded pagination",
      invalid_response:
        "GitHub issue response violates the requested page contract",
      remote_error:
        "GitHub reported a query error; response data is not complete readback",
      transport_error: "GitHub query transport did not produce a response",
      unavailable: "The requested GitHub repository is unavailable",
      partial_response:
        "GitHub returned an unavailable issue node or node list",
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

    const issues = yield* Either.all(
      nodes.map(node =>
        Either.gen(function* () {
          const row = yield* decode(IssueRowSchema, node, "invalid_response")
          const issue = yield* decodeIssueReference({
            repository: row.repository.nameWithOwner,
            number: row.number,
          }).pipe(Either.mapLeft(() => readError("invalid_response")))
          const state = row.state === "OPEN" ? "open" : "closed"

          if (
            issue.repository !== query.repository ||
            row.url.toLowerCase() !==
              `https://github.com/${issue.repository}/issues/${issue.number}` ||
            (query.state !== "all" && state !== query.state)
          )
            return yield* invalid("invalid_response")

          return Object.freeze({
            issue,
            title: row.title,
            url: row.url,
            state,
            updatedAt: row.updatedAt,
          })
        }),
      ),
    )

    if (new Set(issues.map(row => issueKey(row.issue))).size !== issues.length)
      return yield* invalid("invalid_response")

    return Object.freeze({
      repository: owner,
      issues: Object.freeze(issues),
      pageInfo: Object.freeze({ ...pageInfo }),
    })
  })
