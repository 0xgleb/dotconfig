import type { QuestionOption } from "../questions/state.ts"

export const QUESTION_RESOLVED_EVENT = "pi:question-resolved"
export const QUESTION_ASK_EVENT = "pi:question-ask"
export const QUESTION_STATE_EVENT = "pi:question-state"
export const QUESTION_REMOTE_RESOLUTION_EVENT = "pi:question-remote-resolution"
export const QUESTION_PENDING_COUNT_EVENT = "pi:question-pending-count"

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

export interface UserQuestionSnapshot {
  readonly id: number
  readonly status: "pending" | "resolved"
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly QuestionOption[]
}

export interface UserQuestionStateSnapshot {
  readonly questions: readonly UserQuestionSnapshot[]
}

export interface RemoteUserQuestionResolution {
  readonly id: number
  readonly answer: string
}

export interface UserQuestionPendingCount {
  readonly pending: number
}
