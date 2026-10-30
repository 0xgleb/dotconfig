import { Data, Either, Schema } from "effect"
import {
  decodeIssueReference,
  type IssueReference,
  type PlanInputError,
} from "./identity.ts"
import { TaskIdSchema, type TaskPageInput } from "./model.ts"
import {
  decodeTaskMutationBatch,
  type TaskMutationBatch,
  type TaskMutationError,
} from "./mutations.ts"

export type TaskRequest =
  | {
      readonly action: "read"
      readonly issue: IssueReference
      readonly page: TaskPageInput
    }
  | {
      readonly action: "apply"
      readonly batch: TaskMutationBatch
    }

export class TaskRequestError extends Data.TaggedError("TaskRequestError")<{
  readonly code: "invalid_request" | "invalid_page"
  readonly message: string
}> {}

export type TaskRequestDecodeError =
  TaskRequestError | PlanInputError | TaskMutationError

const PageSchema = Schema.Struct({
  limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
  after: Schema.optional(TaskIdSchema),
})
const record = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null && !Array.isArray(input)
const shape = (
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
): input is Readonly<Record<string, unknown>> =>
  record(input) &&
  Reflect.ownKeys(input).every(
    key => typeof key === "string" && allowed.includes(key),
  ) &&
  required.every(key => Object.hasOwn(input, key))
const invalid = (code: TaskRequestError["code"]) =>
  Either.left(
    new TaskRequestError({
      code,
      message:
        code === "invalid_page"
          ? "Task page requires limit 1–100 and an optional canonical task cursor"
          : "Task request requires only its explicit read or apply fields",
    }),
  )

export const decodeTaskRequest = (
  input: unknown,
): Either.Either<TaskRequest, TaskRequestDecodeError> =>
  Either.gen(function* () {
    if (!record(input)) return yield* invalid("invalid_request")
    switch (input.action) {
      case "read": {
        if (
          !shape(
            input,
            ["action", "issue", "page"],
            ["action", "issue", "page"],
          )
        )
          return yield* invalid("invalid_request")
        const issue = yield* decodeIssueReference(input.issue)
        if (!shape(input.page, ["limit", "after"], ["limit"]))
          return yield* invalid("invalid_page")
        const decodedPage = Schema.decodeUnknownEither(PageSchema, {
          onExcessProperty: "error",
        })(input.page)
        if (Either.isLeft(decodedPage)) return yield* invalid("invalid_page")
        const page = Object.freeze({
          limit: decodedPage.right.limit,
          ...(decodedPage.right.after === undefined
            ? {}
            : { after: decodedPage.right.after }),
        })
        return Object.freeze({ action: "read", issue, page })
      }
      case "apply": {
        if (
          !shape(
            input,
            ["action", "issues", "operations"],
            ["action", "issues", "operations"],
          )
        )
          return yield* invalid("invalid_request")
        const batch = yield* decodeTaskMutationBatch({
          issues: input.issues,
          operations: input.operations,
        })
        return Object.freeze({ action: "apply", batch })
      }
      default:
        return yield* invalid("invalid_request")
    }
  })
