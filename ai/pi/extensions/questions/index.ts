import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyQuestionAction,
  decodeQuestionState,
  emptyQuestionState,
  pendingQuestions,
  type QuestionAction,
  type QuestionState,
} from "./state.ts";
import { pendingQuestionContext, questionListText, questionWidgetLines } from "./presentation.ts";

const QUESTION_ENTRY = "pi.questions.state";
const QUESTION_MESSAGE = "pi.questions.list";
const QUESTION_STATUS_KEY = "pi-questions";

interface QuestionRequest {
  readonly action: "list" | "ask" | "resolve" | "clear_resolved";
  readonly question?: string;
  readonly guess?: string;
  readonly id?: number;
  readonly answer?: string;
}

const parseAction: (request: QuestionRequest, state: QuestionState) => QuestionAction = (request, state) => {
  switch (request.action) {
    case "list":
      return { action: "list" };
    case "clear_resolved":
      return { action: "clear_resolved" };
    case "ask": {
      const question = request.question?.trim();
      if (!question) throw new Error("question required for ask");
      return { action: "ask", question, ...(request.guess?.trim() ? { guess: request.guess.trim() } : {}) };
    }
    case "resolve": {
      if (request.id === undefined) throw new Error("id required for resolve");
      const answer = request.answer?.trim();
      if (!answer) throw new Error("answer required for resolve");
      const target = state.questions.find(({ id }) => id === request.id);
      if (!target) throw new Error(`Question q${request.id} not found`);
      if (target.status !== "pending") throw new Error(`Question q${request.id} is already resolved`);
      return { action: "resolve", id: request.id, answer };
    }
  }
};

const questionsExtension: (pi: ExtensionAPI) => void = (pi) => {
  let state = emptyQuestionState;

  const render = (ctx: ExtensionContext) => {
    const lines = questionWidgetLines(state);
    ctx.ui.setStatus(QUESTION_STATUS_KEY, lines.length > 0 ? `awaiting:${pendingQuestions(state).length}` : undefined);
    if (ctx.hasUI) {
      ctx.ui.setWidget(QUESTION_STATUS_KEY, lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
    }
  };

  const restore = (ctx: ExtensionContext) => {
    const entry = ctx.sessionManager
      .getBranch()
      .filter((candidate) => candidate.type === "custom" && candidate.customType === QUESTION_ENTRY)
      .at(-1);
    state = entry?.type === "custom" ? decodeQuestionState(entry.data) ?? emptyQuestionState : emptyQuestionState;
    render(ctx);
  };

  const persist = (ctx: ExtensionContext) => {
    pi.appendEntry(QUESTION_ENTRY, state);
    render(ctx);
  };

  const showQuestions = () => {
    pi.sendMessage({ customType: QUESTION_MESSAGE, content: questionListText(state), display: true });
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(QUESTION_STATUS_KEY, undefined);
    ctx.ui.setWidget(QUESTION_STATUS_KEY, undefined);
  });
  pi.on("before_agent_start", (event) => {
    const content = pendingQuestionContext(state);
    return content
      ? {
          message: { customType: "pi.questions.context", content, display: false },
          systemPrompt: event.systemPrompt,
        }
      : undefined;
  });

  pi.registerCommand("questions", {
    description: "Show questions awaiting user input",
    handler(_args, ctx) {
      restore(ctx);
      showQuestions();
    },
  });

  pi.registerTool({
    name: "ask_user",
    label: "Question queue",
    description: "Queue, list, and resolve persistent non-blocking questions for the user.",
    promptSnippet: "Queue a persistent question for the user without blocking unrelated work",
    promptGuidelines: [
      "Use ask_user when a user decision is required but independent work remains executable.",
      "Include the current best guess so the user can react to a concrete proposal.",
      "Continue independent work after asking; resolve the question with a concise answer summary when the user responds.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("ask"),
        Type.Literal("resolve"),
        Type.Literal("clear_resolved"),
      ]),
      question: Type.Optional(Type.String()),
      guess: Type.Optional(Type.String()),
      id: Type.Optional(Type.Integer({ minimum: 1 })),
      answer: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, request: QuestionRequest, _signal, _onUpdate, ctx) {
      restore(ctx);
      try {
        const action = parseAction(request, state);
        state = applyQuestionAction(state, action);
        if (action.action !== "list") persist(ctx);
        const text =
          action.action === "ask"
            ? `Queued question q${state.nextId - 1}`
            : action.action === "resolve"
              ? `Resolved question q${action.id}`
              : questionListText(state);
        return { content: [{ type: "text", text }], details: { outcome: "success", action: action.action, state } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Question action failed";
        return {
          content: [{ type: "text", text: message }],
          details: { outcome: "error", action: request.action, state, error: message },
        };
      }
    },
  });
};

export default questionsExtension;
