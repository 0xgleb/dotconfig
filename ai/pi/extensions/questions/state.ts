export type QuestionStatus = "pending" | "resolved";

export interface PendingQuestion {
  readonly id: number;
  readonly status: "pending";
  readonly question: string;
  readonly guess?: string;
}

export interface ResolvedQuestion {
  readonly id: number;
  readonly status: "resolved";
  readonly question: string;
  readonly guess?: string;
  readonly answer: string;
}

export type Question = PendingQuestion | ResolvedQuestion;

export interface QuestionState {
  readonly questions: readonly Question[];
  readonly nextId: number;
}

export type QuestionAction =
  | { readonly action: "list" }
  | { readonly action: "ask"; readonly question: string; readonly guess?: string }
  | { readonly action: "resolve"; readonly id: number; readonly answer: string }
  | { readonly action: "clear_resolved" };

export const emptyQuestionState: QuestionState = { questions: [], nextId: 1 };

const isRecord: (value: unknown) => value is Readonly<Record<string, unknown>> = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const decodeQuestionState: (value: unknown) => QuestionState | undefined = (value) => {
  if (!isRecord(value) || !Array.isArray(value.questions) || !Number.isSafeInteger(value.nextId)) return undefined;
  const questions = value.questions.flatMap((candidate): Question[] => {
    if (
      !isRecord(candidate) ||
      !Number.isSafeInteger(candidate.id) ||
      typeof candidate.question !== "string" ||
      (candidate.guess !== undefined && typeof candidate.guess !== "string")
    ) {
      return [];
    }
    const base = {
      id: Number(candidate.id),
      question: candidate.question,
      ...(candidate.guess ? { guess: candidate.guess } : {}),
    };
    if (candidate.status === "pending") return [{ ...base, status: "pending" }];
    if (candidate.status === "resolved" && typeof candidate.answer === "string") {
      return [{ ...base, status: "resolved", answer: candidate.answer }];
    }
    return [];
  });
  if (questions.length !== value.questions.length) return undefined;
  return { questions, nextId: Number(value.nextId) };
};

export const applyQuestionAction: (state: QuestionState, action: QuestionAction) => QuestionState = (state, action) => {
  switch (action.action) {
    case "list":
      return state;
    case "ask":
      return {
        questions: [
          ...state.questions,
          {
            id: state.nextId,
            status: "pending",
            question: action.question.trim(),
            ...(action.guess?.trim() ? { guess: action.guess.trim() } : {}),
          },
        ],
        nextId: state.nextId + 1,
      };
    case "resolve":
      return {
        questions: state.questions.map((question) =>
          question.id === action.id && question.status === "pending"
            ? { ...question, status: "resolved", answer: action.answer.trim() }
            : question,
        ),
        nextId: state.nextId,
      };
    case "clear_resolved":
      return {
        questions: state.questions.filter(({ status }) => status === "pending"),
        nextId: state.nextId,
      };
  }
};

export const pendingQuestions: (state: QuestionState) => readonly PendingQuestion[] = (state) =>
  state.questions.filter((question): question is PendingQuestion => question.status === "pending");
