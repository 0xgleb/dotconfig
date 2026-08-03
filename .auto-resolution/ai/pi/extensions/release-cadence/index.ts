import { basename } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runtimeProjectContext } from "../classified-workflows/project-context.ts";
import { isContinuationPaused } from "../shared/continuation-pause.ts";
import { AUTO_RELOAD_PENDING_REQUEST_EVENT, type AutoReloadPendingReporter } from "../shared/reload-events.ts";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import {
  dueReleaseCadenceReminder,
  initialReleaseCadenceState,
  nextQuarterBoundaryAt,
  quarterBoundaryAt,
  type ReleaseCadenceState,
} from "./core.ts";

const STATE_ENTRY = "release-cadence.state";
const REMINDER_ENTRY = "release-cadence.notice";
const REMINDER_MESSAGE = "release-cadence.reminder";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TIMEZONE_QUALIFIED_ISO = /(?:Z|[+-]\d{2}:\d{2})$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const CadenceParameters = Type.Object({
  action: StringEnum(["status", "enable", "disable", "mark"] as const),
  version: Type.Optional(Type.String({ maxLength: 80 })),
  at: Type.Optional(Type.String({ maxLength: 80 })),
});

const decodeState = (value: unknown): ReleaseCadenceState | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.lastReminderBoundaryAt !== "number" ||
    !Number.isSafeInteger(candidate.lastReminderBoundaryAt) ||
    (candidate.lastTriggeredReleaseAt !== undefined &&
      (typeof candidate.lastTriggeredReleaseAt !== "number" || !Number.isSafeInteger(candidate.lastTriggeredReleaseAt)))
  ) return undefined;
  const base = {
    enabled: candidate.enabled,
    lastReminderBoundaryAt: candidate.lastReminderBoundaryAt,
    ...(typeof candidate.lastTriggeredReleaseAt === "number"
      ? { lastTriggeredReleaseAt: candidate.lastTriggeredReleaseAt }
      : {}),
  };
  const latest = candidate.latestRelease;
  if (latest === undefined) return base;
  if (typeof latest !== "object" || latest === null || Array.isArray(latest)) return undefined;
  const marker = latest as Record<string, unknown>;
  if (typeof marker.version !== "string" || typeof marker.at !== "number" || !Number.isSafeInteger(marker.at)) {
    return undefined;
  }
  return { ...base, latestRelease: { version: marker.version, at: marker.at } };
};

const isYielduckProject = (cwd: string): boolean => {
  const root = runtimeProjectContext(cwd).gitToplevel;
  return root !== undefined && basename(root) === "yielduck";
};

const restoredState = (ctx: ExtensionContext, now: number): ReleaseCadenceState =>
  ctx.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === STATE_ENTRY
        ? (decodeState(entry.data) ? [decodeState(entry.data)!] : [])
        : [],
    )
    .at(-1) ?? initialReleaseCadenceState(now);

const statusText = (state: ReleaseCadenceState): string => {
  const marker = state.latestRelease
    ? `${state.latestRelease.version} at ${new Date(state.latestRelease.at).toISOString()}`
    : "no verified live marker recorded";
  return `Release cadence ${state.enabled ? "enabled" : "disabled"}; ${marker}; next quarter ${new Date(nextQuarterBoundaryAt(Date.now())).toISOString()}.`;
};

export default (pi: ExtensionAPI) => {
  registerRuntimeVersion(pi, "release-cadence", "2026.07.23.2");
  pi.registerEntryRenderer(REMINDER_ENTRY, (entry, _options, theme) => {
    const content =
      typeof entry.data === "object" && entry.data !== null && "content" in entry.data && typeof entry.data.content === "string"
        ? entry.data.content
        : "Release cadence reminder.";
    return new Text(`${theme.fg("accent", "[release cadence]\n")}${content}`, 0, 0);
  });
  let active = false;
  let state = initialReleaseCadenceState(Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;

  const autoReloadPending = (): boolean => {
    let pending = false;
    const report: AutoReloadPendingReporter = (value) => {
      pending ||= value;
    };
    pi.events.emit(AUTO_RELOAD_PENDING_REQUEST_EVENT, report);
    return pending;
  };

  const persist = () => pi.appendEntry(STATE_ENTRY, state);

  const renderStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("release-cadence", active && state.enabled ? "ship:15m" : undefined);
  };

  let wakeDueReminder: (ctx: ExtensionContext) => Promise<void>;

  const schedule = (ctx: ExtensionContext) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!active || !state.enabled) return;
    const due = dueReleaseCadenceReminder(state, Date.now());
    const nextAt = due?.boundaryAt ?? nextQuarterBoundaryAt(Date.now());
    const delay = Math.min(Math.max(0, nextAt - Date.now()), MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timer = undefined;
      void wakeDueReminder(ctx);
    }, delay);
  };

  wakeDueReminder = async (ctx: ExtensionContext) => {
    if (!active || !state.enabled) return;
    const due = dueReleaseCadenceReminder(state, Date.now());
    if (!due) {
      schedule(ctx);
      return;
    }
    if (
      isContinuationPaused(ctx.sessionManager.getBranch()) ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      autoReloadPending()
    ) return;

    state = due.nextState;
    persist();
    renderStatus(ctx);
    schedule(ctx);
    if (due.triggerTurn) {
      pi.sendMessage(
        { customType: REMINDER_MESSAGE, content: due.content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else {
      pi.appendEntry(REMINDER_ENTRY, { content: due.content });
    }
    if (ctx.hasUI) {
      const message = due.cadenceFailure
        ? "Release cadence failure: more than 60 minutes since the live marker."
        : due.triggerTurn
          ? "Quarter-hour release reminder."
          : "Quarter-hour release reminder surfaced without starting another agent turn.";
      ctx.ui.notify(message, due.cadenceFailure ? "warning" : "info");
    }
  };

  const reconstruct = async (ctx: ExtensionContext) => {
    active = isYielduckProject(ctx.cwd);
    if (!active) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      ctx.ui.setStatus("release-cadence", undefined);
      return;
    }
    state = restoredState(ctx, Date.now());
    persist();
    renderStatus(ctx);
    schedule(ctx);
    await wakeDueReminder(ctx);
  };

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_compact", async (_event, ctx) => {
    if (!active) return;
    persist();
    renderStatus(ctx);
    schedule(ctx);
    await wakeDueReminder(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => wakeDueReminder(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    active = false;
    ctx.ui.setStatus("release-cadence", undefined);
  });

  pi.registerTool({
    name: "release_cadence",
    label: "Release cadence",
    description: "Status, enable, disable, or record a verified live Yielduck release marker for durable quarter-hour reminders.",
    promptSnippet: "Maintain the verified live release marker used by Yielduck quarter-hour cadence reminders",
    promptGuidelines: [
      "Use release_cadence mark only after a safe dashboard or live version marker has been verified; never infer a release from a commit or build alone.",
    ],
    parameters: CadenceParameters,
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      if (!isYielduckProject(ctx.cwd)) {
        return { content: [{ type: "text" as const, text: "Release cadence is available only in the Yielduck repository." }], details: { outcome: "inactive" } };
      }
      active = true;
      if (request.action === "status") {
        return { content: [{ type: "text" as const, text: statusText(state) }], details: { outcome: "status", state } };
      }
      if (request.action === "enable") {
        state = { ...state, enabled: true, lastReminderBoundaryAt: quarterBoundaryAt(Date.now()) };
      } else if (request.action === "disable") {
        state = { ...state, enabled: false };
      } else {
        const version = request.version?.trim();
        const timestamp = request.at?.trim();
        if (!version || !VERSION.test(version) || !timestamp || !TIMEZONE_QUALIFIED_ISO.test(timestamp)) {
          return { content: [{ type: "text" as const, text: "mark requires a semantic version and timezone-qualified ISO-8601 at timestamp." }], details: { outcome: "error" }, isError: true };
        }
        const releaseAt = Date.parse(timestamp);
        if (!Number.isFinite(releaseAt) || releaseAt > Date.now() + 5 * 60_000 || (state.latestRelease && releaseAt < state.latestRelease.at)) {
          return { content: [{ type: "text" as const, text: "release marker must be valid, not materially future-dated, and not older than the recorded marker." }], details: { outcome: "error" }, isError: true };
        }
        state = { ...state, latestRelease: { version, at: releaseAt } };
      }
      persist();
      renderStatus(ctx);
      schedule(ctx);
      return { content: [{ type: "text" as const, text: statusText(state) }], details: { outcome: request.action, state } };
    },
  });

  pi.registerCommand("release-cadence", {
    description: "Show, enable, or disable Yielduck quarter-hour release reminders",
    handler(args, ctx) {
      const action = args.trim() || "status";
      if (!active || !isYielduckProject(ctx.cwd)) {
        ctx.ui.notify("Release cadence is available only in the Yielduck repository.", "warning");
        return;
      }
      if (action === "enable") {
        state = { ...state, enabled: true, lastReminderBoundaryAt: quarterBoundaryAt(Date.now()) };
        persist();
        renderStatus(ctx);
        schedule(ctx);
      } else if (action === "disable") {
        state = { ...state, enabled: false };
        persist();
        renderStatus(ctx);
        schedule(ctx);
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /release-cadence [status|enable|disable]", "warning");
        return;
      }
      ctx.ui.notify(statusText(state), "info");
    },
  });
};
