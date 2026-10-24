export type QuestionStatus = "pending" | "resolved"

export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

export interface PendingQuestion {
  readonly id: number
  readonly status: "pending"
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly QuestionOption[]
}

export interface ResolvedQuestion {
  readonly id: number
  readonly status: "resolved"
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly QuestionOption[]
  readonly answer: string
  readonly withdrawn?: true
}

export type Question = PendingQuestion | ResolvedQuestion

export interface QuestionState {
  readonly questions: readonly Question[]
  readonly nextId: number
}

export type QuestionAction =
  | { readonly action: "list" }
  | {
      readonly action: "ask"
      readonly question: string
      readonly header?: string
      readonly guess?: string
      readonly options?: readonly QuestionOption[]
    }
  | { readonly action: "resolve"; readonly id: number; readonly answer: string }
  | {
      readonly action: "withdraw"
      readonly id: number
      readonly reason: string
    }
  | {
      readonly action: "replace"
      readonly id: number
      readonly reason: string
      readonly question: string
      readonly header?: string
      readonly guess?: string
      readonly options?: readonly QuestionOption[]
    }
  | { readonly action: "reopen"; readonly id: number }
  | { readonly action: "clear_resolved" }

export const emptyQuestionState: QuestionState = { questions: [], nextId: 1 }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const decodeQuestionState: (
  value: unknown,
) => QuestionState | undefined = value => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.questions) ||
    !Number.isSafeInteger(value.nextId)
  )
    return undefined
  const questions = value.questions.flatMap((candidate): Question[] => {
    if (
      !isRecord(candidate) ||
      !Number.isSafeInteger(candidate.id) ||
      typeof candidate.question !== "string" ||
      (candidate.header !== undefined &&
        typeof candidate.header !== "string") ||
      (candidate.guess !== undefined && typeof candidate.guess !== "string") ||
      (candidate.options !== undefined &&
        (!Array.isArray(candidate.options) ||
          !candidate.options.every(
            option =>
              isRecord(option) &&
              typeof option.label === "string" &&
              (option.description === undefined ||
                typeof option.description === "string"),
          ))) ||
      (candidate.withdrawn !== undefined && candidate.withdrawn !== true)
    ) {
      return []
    }
    const base = {
      id: Number(candidate.id),
      question: candidate.question,
      ...(candidate.header ? { header: candidate.header } : {}),
      ...(candidate.guess ? { guess: candidate.guess } : {}),
      ...(candidate.options
        ? { options: candidate.options as unknown as readonly QuestionOption[] }
        : {}),
    }
    if (candidate.status === "pending") return [{ ...base, status: "pending" }]
    if (
      candidate.status === "resolved" &&
      typeof candidate.answer === "string"
    ) {
      return [
        {
          ...base,
          status: "resolved",
          answer: candidate.answer,
          ...(candidate.withdrawn === true ? { withdrawn: true as const } : {}),
        },
      ]
    }
    return []
  })
  if (questions.length !== value.questions.length) return undefined
  return { questions, nextId: Number(value.nextId) }
}

export const applyQuestionAction: (
  state: QuestionState,
  action: QuestionAction,
) => QuestionState = (state, action) => {
  switch (action.action) {
    case "list":
      return state
    case "ask":
      return {
        questions: [
          ...state.questions,
          {
            id: state.nextId,
            status: "pending",
            question: action.question.trim(),
            ...(action.header?.trim() ? { header: action.header.trim() } : {}),
            ...(action.guess?.trim() ? { guess: action.guess.trim() } : {}),
            ...(action.options && action.options.length > 0
              ? { options: action.options }
              : {}),
          },
        ],
        nextId: state.nextId + 1,
      }
    case "resolve":
      return {
        questions: state.questions.map(question =>
          question.id === action.id && question.status === "pending"
            ? { ...question, status: "resolved", answer: action.answer.trim() }
            : question,
        ),
        nextId: state.nextId,
      }
    case "withdraw":
      return {
        questions: state.questions.map(question =>
          question.id === action.id
            ? {
                ...question,
                status: "resolved" as const,
                answer: action.reason.trim(),
                withdrawn: true as const,
              }
            : question,
        ),
        nextId: state.nextId,
      }
    case "replace":
      return {
        questions: [
          ...state.questions.map(question =>
            question.id === action.id
              ? {
                  ...question,
                  status: "resolved" as const,
                  answer: action.reason.trim(),
                  withdrawn: true as const,
                }
              : question,
          ),
          {
            id: state.nextId,
            status: "pending" as const,
            question: action.question.trim(),
            ...(action.header?.trim() ? { header: action.header.trim() } : {}),
            ...(action.guess?.trim() ? { guess: action.guess.trim() } : {}),
            ...(action.options && action.options.length > 0
              ? { options: action.options }
              : {}),
          },
        ],
        nextId: state.nextId + 1,
      }
    case "reopen":
      return {
        questions: state.questions.map(question =>
          question.id === action.id && question.status === "resolved"
            ? {
                id: question.id,
                status: "pending" as const,
                question: question.question,
                ...(question.header ? { header: question.header } : {}),
                ...(question.guess ? { guess: question.guess } : {}),
                ...(question.options ? { options: question.options } : {}),
              }
            : question,
        ),
        nextId: state.nextId,
      }
    case "clear_resolved":
      return {
        questions: state.questions.filter(({ status }) => status === "pending"),
        nextId: state.nextId,
      }
  }
}

export const repairMisroutedPromptAnswers = (
  state: QuestionState,
): QuestionState => ({
  ...state,
  questions: state.questions.map(question => {
    if (
      question.status !== "resolved" ||
      !/screencaptureui/i.test(question.answer) ||
      !/trying to do a normal prompt/i.test(question.answer)
    ) {
      return question
    }
    return {
      id: question.id,
      status: "pending" as const,
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      ...(question.guess ? { guess: question.guess } : {}),
      ...(question.options ? { options: question.options } : {}),
    }
  }),
})

const QUESTION_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "do",
  "does",
  "for",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "should",
  "the",
  "this",
  "to",
  "use",
  "we",
  "what",
  "which",
  "with",
  "you",
])

const normalizedQuestion = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")

const significantQuestionTokens = (value: string): ReadonlySet<string> =>
  new Set(
    normalizedQuestion(value)
      .split(" ")
      .filter(
        token =>
          token.length > 1 &&
          !/^\d+$/.test(token) &&
          !QUESTION_STOP_WORDS.has(token),
      ),
  )

export const repeatedQuestion: (
  state: QuestionState,
  candidate: string,
) => Question | undefined = (state, candidate) => {
  const normalizedCandidate = normalizedQuestion(candidate)
  const candidateTokens = significantQuestionTokens(candidate)
  return state.questions.find(question => {
    if (question.status === "resolved" && question.withdrawn) return false
    if (normalizedQuestion(question.question) === normalizedCandidate)
      return true
    const existingTokens = significantQuestionTokens(question.question)
    if (candidateTokens.size < 5 || existingTokens.size < 5) return false
    const intersection = [...candidateTokens].filter(token =>
      existingTokens.has(token),
    ).length
    return (
      intersection >= 5 &&
      intersection / Math.min(candidateTokens.size, existingTokens.size) >=
        0.72 &&
      intersection / Math.max(candidateTokens.size, existingTokens.size) >= 0.5
    )
  })
}

export const pendingQuestions: (
  state: QuestionState,
) => readonly PendingQuestion[] = state =>
  state.questions.filter(
    (question): question is PendingQuestion => question.status === "pending",
  )
