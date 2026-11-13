import { Either, Schema } from "effect"
import { GitHubReadError } from "./github-read.ts"

export const GitHubUserIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1024),
  Schema.filter(value => !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value)),
  Schema.brand("GitHubUserId"),
)

export const GitHubUserSchema = Schema.Struct({
  id: GitHubUserIdSchema,
  login: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(100),
    Schema.filter(value => !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value)),
  ),
})

export type GitHubUser = typeof GitHubUserSchema.Type

const AssigneesSchema = Schema.Struct({
  nodes: Schema.NullOr(
    Schema.Array(Schema.NullOr(GitHubUserSchema)).pipe(Schema.maxItems(100)),
  ),
  totalCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  pageInfo: Schema.Struct({
    hasNextPage: Schema.Boolean,
    endCursor: Schema.NullOr(Schema.String),
  }),
})

export const decodeGitHubAssignees = (
  input: unknown,
): Either.Either<readonly GitHubUser[], GitHubReadError> =>
  Either.gen(function* () {
    const invalid = (code: "invalid_response" | "partial_response") =>
      new GitHubReadError({
        code,
        message: "GitHub assignee evidence is unavailable or incomplete",
      })
    if (input === null) return yield* Either.left(invalid("partial_response"))
    const connection = yield* Schema.decodeUnknownEither(AssigneesSchema)(
      input,
    ).pipe(Either.mapLeft(() => invalid("invalid_response")))
    if (
      connection.nodes === null ||
      connection.nodes.some(user => user === null) ||
      connection.pageInfo.hasNextPage
    )
      return yield* Either.left(invalid("partial_response"))
    const users = connection.nodes.filter(user => user !== null)
    if (
      connection.totalCount !== users.length ||
      new Set(users.map(user => user.id)).size !== users.length ||
      new Set(users.map(user => user.login.toLowerCase())).size !== users.length
    )
      return yield* Either.left(invalid("invalid_response"))
    return Object.freeze(users.map(user => Object.freeze({ ...user })))
  })
