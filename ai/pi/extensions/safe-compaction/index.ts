import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import {
  SAFE_COMPACTION_ENTRY,
  beforeCompactionTransition,
  idleSafeCompactionState,
  overflowFallbackSummary,
  preparationMessage,
  restoreSafeCompactionState,
  resumeMessage,
  type SafeCompactionState,
} from "./state.ts";

const MESSAGE_TYPE = "safe-compaction.message";
const MAX_RESUME_NOTES = 4_000;

const boundedNotes = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_RESUME_NOTES);

export default function safeCompaction(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "safe-compaction", "2026.07.23.2");
  let state: SafeCompactionState = idleSafeCompactionState;
  let compactRequested = false;
  let latestCtx: ExtensionContext | undefined;

  const persist = (next: SafeCompactionState): void => {
    state = next;
    pi.appendEntry(SAFE_COMPACTION_ENTRY, state);
    latestCtx?.ui.setStatus("safe-compaction", state.phase === "idle" ? undefined : `compact:${state.phase}`);
  };

  const sendPreparation = (reason: "manual" | "threshold"): void => {
    setTimeout(() => {
      pi.sendMessage(
        { customType: MESSAGE_TYPE, content: preparationMessage(reason), display: true, details: { phase: "preparing", reason } },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }, 0);
  };

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    state = restoreSafeCompactionState(ctx.sessionManager.getBranch());
    compactRequested = false;
    ctx.ui.setStatus("safe-compaction", state.phase === "idle" ? undefined : `compact:${state.phase}`);
    if (state.phase === "preparing") sendPreparation(state.reason);
  });

  pi.on("session_before_compact", (event, ctx) => {
    latestCtx = ctx;
    const transition = beforeCompactionTransition(state, event.reason, Date.now());
    persist(transition.state);
    if (transition.notifyPreparation && transition.state.phase === "preparing") {
      sendPreparation(transition.state.reason);
    }
    if (event.reason === "overflow" && transition.state.phase === "forced") {
      return {
        compaction: {
          summary: overflowFallbackSummary(event.preparation.previousSummary, transition.state.resumeNotes),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    }
    return transition.cancel ? { cancel: true } : undefined;
  });

  pi.on("session_compact", (_event, ctx) => {
    latestCtx = ctx;
    compactRequested = false;
    const completed = state;
    persist(idleSafeCompactionState);
    if (completed.phase === "idle" || completed.phase === "preparing") return;
    setTimeout(() => {
      pi.sendMessage(
        {
          customType: MESSAGE_TYPE,
          content: resumeMessage(completed),
          display: true,
          details: { phase: "resuming", reason: completed.reason },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }, 0);
  });

  pi.on("agent_settled", (_event, ctx) => {
    latestCtx = ctx;
    if (state.phase !== "ready" || compactRequested) return;
    compactRequested = true;
    ctx.compact({
      customInstructions:
        "Preserve active goals, every pending or blocked todo, exact unfinished tool actions, verified evidence, decisions, and the safe-compaction resume notes. A tool call without a successful tool result was not executed.",
      onError: (error) => {
        compactRequested = false;
        ctx.ui.notify(`Safe compaction failed: ${error.message}`, "error");
      },
    });
  });

  pi.on("session_shutdown", () => {
    latestCtx = undefined;
  });

  pi.registerTool({
    name: "safe_compaction_ready",
    label: "Safe compaction ready",
    description:
      "Acknowledge that pre-compaction state is durable and provide exact bounded resume notes. Use only after reconciling goals, todos, and unfinished tool calls.",
    promptSnippet: "Confirm readiness for pending safe compaction after persisting critical state",
    promptGuidelines: [
      "Call safe_compaction_ready only after persisting critical state and naming the exact post-compaction next action.",
      "A displayed tool call without a successful tool result was not executed; include it in safe_compaction_ready resume notes when still required.",
    ],
    parameters: Type.Object({
      resumeNotes: Type.String({ minLength: 1, maxLength: MAX_RESUME_NOTES }),
    }),
    async execute(_toolCallId, params) {
      if (state.phase !== "preparing") {
        return {
          content: [{ type: "text" as const, text: "No safe compaction preparation is pending." }],
          details: { outcome: "not-pending" as const },
        };
      }
      const resumeNotes = boundedNotes(params.resumeNotes);
      if (!resumeNotes) {
        return {
          content: [{ type: "text" as const, text: "Resume notes must contain meaningful text." }],
          details: { outcome: "invalid" as const },
        };
      }
      persist({
        phase: "ready",
        reason: state.reason,
        requestedAt: state.requestedAt,
        readyAt: Date.now(),
        resumeNotes,
      });
      return {
        content: [{ type: "text" as const, text: "Safe compaction readiness recorded. Compaction will begin after this turn settles." }],
        details: { outcome: "ready" as const },
        terminate: true,
      };
    },
  });
}
