import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_PHASE_EVENT, type ClassifierActivityEvent } from "../shared/activity-events.ts";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import { assistantPhase, runningToolsPhase, toolPhase, type ActivityPhase } from "./core.ts";

const STATUS_KEY = "activity-phase";

export default function activityStatus(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "activity-status", "2026.07.23.1");
  const runningTools = new Map<string, string>();
  let latestCtx: ExtensionContext | undefined;
  let classifierDepth = 0;

  const show = (phase: ActivityPhase, ctx = latestCtx): void => {
    if (!ctx) return;
    latestCtx = ctx;
    ctx.ui.setWorkingMessage(phase.label);
    ctx.ui.setStatus(STATUS_KEY, phase.label);
  };

  const showRunningTools = (ctx = latestCtx): void => {
    if (!ctx) return;
    const names = [...runningTools.values()];
    show(names.length > 0 ? runningToolsPhase(names) : { kind: "model", label: "MODEL · integrating tool results" }, ctx);
  };

  pi.events.on(ACTIVITY_PHASE_EVENT, (event: ClassifierActivityEvent) => {
    classifierDepth = Math.max(0, classifierDepth + (event.active ? 1 : -1));
    if (event.active) {
      show({
        kind: "classifier",
        label: `CLASSIFIER · ${event.boundary} · model generation · ${event.subject}`,
      });
    } else if (classifierDepth === 0) {
      showRunningTools();
    }
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    runningTools.clear();
    classifierDepth = 0;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
  });

  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx;
    runningTools.clear();
    show({ kind: "model", label: "MODEL · awaiting generation" }, ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    if (runningTools.size === 0 && classifierDepth === 0) show({ kind: "model", label: "MODEL · generating" }, ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (classifierDepth > 0 || runningTools.size > 0 || event.message.role !== "assistant") return;
    const phase = assistantPhase(event.message);
    if (phase) show(phase, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    runningTools.set(event.toolCallId, event.toolName);
    if (classifierDepth === 0) showRunningTools(ctx);
  });

  pi.on("tool_execution_update", (event, ctx) => {
    runningTools.set(event.toolCallId, event.toolName);
    if (classifierDepth === 0) showRunningTools(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    runningTools.delete(event.toolCallId);
    if (classifierDepth === 0) showRunningTools(ctx);
  });

  pi.on("session_before_compact", (_event, ctx) => {
    show({ kind: "compacting", label: "COMPACTING · preparing durable summary" }, ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    show({ kind: "model", label: "MODEL · resuming after compaction" }, ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    runningTools.clear();
    classifierDepth = 0;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
    latestCtx = undefined;
  });
}
