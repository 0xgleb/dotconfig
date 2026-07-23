import type { QuestionOption } from "../questions/state.ts";

export const QUESTION_RESOLVED_EVENT = "pi:question-resolved";
export const QUESTION_ASK_EVENT = "pi:question-ask";

export interface UserQuestionRequest {
  readonly question: string;
  readonly header?: string;
  readonly guess?: string;
  readonly options?: readonly QuestionOption[];
}

export interface UserQuestionResolution {
  readonly id: number;
  readonly answer: string;
}
