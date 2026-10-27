import { Data, Either, Schema } from "effect"

const RepositoryInputSchema = Schema.String.pipe(
  Schema.pattern(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/u,
  ),
  Schema.filter(value => !/[\u0000-\u0020\u007f]/u.test(value)),
  Schema.filter(value => !value.split("/")[0]?.includes("--")),
  Schema.filter(value => ![".", ".."].includes(value.split("/")[1] ?? "")),
)
const RepositorySchema = RepositoryInputSchema.pipe(
  Schema.brand("IssueRepository"),
)
const IssueNumberSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  Schema.brand("IssueNumber"),
)

export type IssueRepository = typeof RepositorySchema.Type
export type IssueNumber = typeof IssueNumberSchema.Type

export interface IssueReference {
  readonly repository: IssueRepository
  readonly number: IssueNumber
}

export class PlanInputError extends Data.TaggedError("PlanInputError")<{
  readonly code: "invalid_issue" | "invalid_scope"
  readonly message: string
}> {}

export const decodeIssueReference = (
  value: unknown,
): Either.Either<IssueReference, PlanInputError> =>
  Either.gen(function* () {
    const invalid = () =>
      new PlanInputError({
        code: "invalid_issue",
        message:
          "An issue requires only a repository (owner/name) and a positive safe integer number.",
      })
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("repository" in value) ||
      typeof value.repository !== "string" ||
      !("number" in value) ||
      Object.keys(value).some(key => !["repository", "number"].includes(key))
    )
      return yield* Either.left(invalid())

    const original = yield* Schema.decodeUnknownEither(RepositoryInputSchema)(
      value.repository,
    ).pipe(Either.mapLeft(invalid))
    const repository = yield* Schema.decodeUnknownEither(RepositorySchema)(
      original.toLowerCase(),
    ).pipe(Either.mapLeft(invalid))
    const number = yield* Schema.decodeUnknownEither(IssueNumberSchema)(
      value.number,
    ).pipe(Either.mapLeft(invalid))

    return Object.freeze({ repository, number })
  })

export const issueKey = (issue: IssueReference): string =>
  `${issue.repository}#${issue.number}`

export const MAX_PLAN_ISSUES_PER_CALL = 100

export const decodeIssueScope = (
  value: unknown,
): Either.Either<readonly IssueReference[], PlanInputError> =>
  Either.gen(function* () {
    const invalid = () =>
      new PlanInputError({
        code: "invalid_scope",
        message: `Issue scope requires 1–${MAX_PLAN_ISSUES_PER_CALL} distinct repository-qualified issues.`,
      })
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_PLAN_ISSUES_PER_CALL
    )
      return yield* Either.left(invalid())

    const issues = yield* Either.all(
      Array.from(value, item =>
        decodeIssueReference(item).pipe(Either.mapLeft(invalid)),
      ),
    )

    if (new Set(issues.map(issueKey)).size !== issues.length)
      return yield* Either.left(invalid())

    return Object.freeze(issues)
  })
