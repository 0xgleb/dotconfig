import { pendingQuestions, type QuestionState } from "./state.ts";

const compact: (text: string, limit?: number) => string = (text, limit = 180) => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 3)}...`;
};

export const questionWidgetLines: (state: QuestionState) => string[] = (state) => {
  const pending = pendingQuestions(state);
  if (pending.length === 0) return [];
  return [
    `Awaiting your input: ${pending.length} · /questions`,
    ...pending.flatMap((question) => [
      `? q${question.id} · ${compact(question.question)}`,
      ...(question.guess ? [`  Guess: ${compact(question.guess)}`] : []),
    ]),
  ];
};

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
