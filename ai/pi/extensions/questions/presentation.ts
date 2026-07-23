import { pendingQuestions, type QuestionState } from "./state.ts";

export const questionListText: (state: QuestionState) => string = (state) => {
  if (state.questions.length === 0) return "No queued questions.";
  return state.questions
    .flatMap((question) => [
      `${question.status === "pending" ? "?" : "✓"} q${question.id} · ${question.question}`,
      ...(question.guess ? [`  Guess: ${question.guess}`] : []),
      ...(question.status === "resolved" ? [`  Answer: ${question.answer}`] : []),
    ])
    .join("\n");
};

export const pendingQuestionContext: (state: QuestionState) => string | undefined = (state) => {
  const pending = pendingQuestions(state);
  if (pending.length === 0) return undefined;
  return `Questions still awaiting the user's input:\n${pending
    .map((question) => `- q${question.id}: ${question.question}${question.guess ? `\n  Current guess: ${question.guess}` : ""}`)
    .join("\n")}\nContinue independent work. Do not silently assume answers.`;
};
