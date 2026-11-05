import { Data, Either, Schema } from "effect"
import type { QuestionOption } from "../questions/state.ts"

export const QUESTION_RESOLVED_EVENT = "pi:question-resolved"
export const QUESTION_ASK_EVENT = "pi:question-ask"
export const QUESTION_STATE_EVENT = "pi:question-state"
export const QUESTION_REMOTE_RESOLUTION_EVENT = "pi:question-remote-resolution"
export const QUESTION_PENDING_COUNT_EVENT = "pi:question-pending-count"
export const QUESTION_STATE_ENTRY = "pi.questions.state"

export interface UserQuestionRequest {
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly QuestionOption[]
}

export interface UserQuestionResolution {
  readonly id: number
  readonly answer: string
}

interface UserQuestionSnapshotBase {
  readonly id: number
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly QuestionOption[]
}

export type UserQuestionSnapshot =
  | (UserQuestionSnapshotBase & { readonly status: "pending" })
  | (UserQuestionSnapshotBase & {
      readonly status: "resolved"
      readonly answer: string
    })

export interface UserQuestionStateSnapshot {
  readonly questions: readonly UserQuestionSnapshot[]
}

export class QuestionStateSnapshotError extends Data.TaggedError(
  "QuestionStateSnapshotError",
)<{ readonly message: string }> {}

export const decodeUserQuestionStateSnapshot = (
  input: unknown,
): Either.Either<UserQuestionStateSnapshot, QuestionStateSnapshotError> =>
  Either.mapLeft(
    Schema.decodeUnknownEither(userQuestionStateSnapshotSchema)(input),
    () =>
      new QuestionStateSnapshotError({
        message: "Question state update rejected: malformed snapshot.",
      }),
  )

const optionalSnapshotString = Schema.optionalWith(Schema.String, {
  exact: true,
})

const questionSnapshotFields = {
  id: Schema.Number.pipe(
    Schema.filter(value => Number.isSafeInteger(value) && value > 0),
  ),
  question: Schema.String,
  header: optionalSnapshotString,
  guess: optionalSnapshotString,
  options: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        description: optionalSnapshotString,
      }),
    ),
    { exact: true },
  ),
}

const userQuestionStateSnapshotSchema: Schema.Schema<UserQuestionStateSnapshot> =
  Schema.Struct({
    questions: Schema.Array(
      Schema.Union(
        Schema.Struct({
          ...questionSnapshotFields,
          status: Schema.Literal("pending"),
        }),
        Schema.Struct({
          ...questionSnapshotFields,
          status: Schema.Literal("resolved"),
          answer: Schema.String,
        }),
      ),
    ),
  })

export interface RemoteUserQuestionResolution {
  readonly id: number
  readonly answer: string
}

export interface UserQuestionPendingCount {
  readonly pending: number
}
