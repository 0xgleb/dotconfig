export const QUESTION_RESOLVED_EVENT = "pi:question-resolved";

export interface UserQuestionResolution {
  readonly id: number;
  readonly answer: string;
}
