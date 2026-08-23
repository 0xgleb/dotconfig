import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import {
  AUTO_RELOAD_ACTIVITY_REQUEST_EVENT,
  type AutoReloadActivityReporter,
} from "../shared/reload-events.ts"
import { SAFE_COMPACTION_INTERRUPT_EVENT } from "../shared/safe-compaction-events.ts"
import {
  SAFE_COMPACTION_ENTRY,
  beforeCompactionTransition,
  compactionResumeMode,
  idleSafeCompactionState,
  latestBoundedUserRequest,
  overflowFallbackSummary,
  overflowRecoveryFirstKeptEntryId,
  preparationMessage,
  restoreSafeCompactionState,
  resumeMessage,
  thresholdBlockedSafeCompactionState,
  type SafeCompactionState,
} from "./state.ts"
import { compactionVisual, type SafeCompactionMessagePhase } from "./visual.ts"

const MESSAGE_TYPE = "safe-compaction.message"
const MAX_RESUME_NOTES = 4_000

const boundedNotes = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RESUME_NOTES)

interface CompactionMessageDetails {
  readonly phase: SafeCompactionMessagePhase
  readonly reason: "manual" | "threshold" | "overflow"
}

const compactionMessageDetails = (
  value: unknown,
): CompactionMessageDetails | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const details = value as Readonly<Record<string, unknown>>
  if (
    (details.phase !== "preparing" && details.phase !== "resuming") ||
    (details.reason !== "manual" &&
      details.reason !== "threshold" &&
      details.reason !== "overflow")
  )
    return undefined
  return {
    phase: details.phase,
    reason: details.reason,
  }
}

export default function safeCompaction(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "safe-compaction", "2026.08.23.1")
  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
    const details = compactionMessageDetails(message.details)
    if (!details) return new Text(String(message.content), options.outputPad, 0)
    const visual = compactionVisual(details.reason, details.phase)
    const heading = theme.fg(
      visual.foreground,
      theme.bold(`${visual.heading} · ${visual.label}`),
    )
    const box = new Box(options.outputPad, 1, text =>
      theme.bg(visual.background, text),
    )
    box.addChild(
      new Text(
        `${heading}\n${theme.fg("customMessageText", String(message.content))}`,
        0,
        0,
      ),
    )
    return box
  })
  let state: SafeCompactionState = idleSafeCompactionState
  let compactRequested = false
  let pendingAutomaticResume:
    | Exclude<SafeCompactionState, { phase: "idle" | "preparing" }>
    | undefined
  let latestCtx: ExtensionContext | undefined

  pi.events.on(
    AUTO_RELOAD_ACTIVITY_REQUEST_EVENT,
    (report: AutoReloadActivityReporter) => {
      report(
        state.phase !== "idle" ||
          compactRequested ||
          pendingAutomaticResume !== undefined,
      )
    },
  )

  const persist = (next: SafeCompactionState): void => {
    state = next
    pi.appendEntry(SAFE_COMPACTION_ENTRY, state)
    latestCtx?.ui.setStatus(
      "safe-compaction",
      state.phase === "idle" ? undefined : `compact:${state.phase}`,
    )
  }

  const sendPreparation = (reason: "manual" | "threshold"): void => {
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: preparationMessage(reason),
        display: true,
        details: { phase: "preparing", reason },
      },
      { deliverAs: "followUp", triggerTurn: true },
    )
  }

  const sendResume = (
    completed: Exclude<SafeCompactionState, { phase: "idle" | "preparing" }>,
  ): void => {
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: resumeMessage(completed),
        display: true,
        details: { phase: "resuming", reason: completed.reason },
      },
      { deliverAs: "followUp", triggerTurn: true },
    )
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx
    state = restoreSafeCompactionState(ctx.sessionManager.getBranch())
    compactRequested = false
    pendingAutomaticResume = undefined
    ctx.ui.setStatus(
      "safe-compaction",
      state.phase === "idle" ? undefined : `compact:${state.phase}`,
    )
    if (state.phase === "preparing") sendPreparation(state.reason)
  })

  pi.on("input", event => {
    if (
      event.source === "extension" ||
      state.phase !== "idle" ||
      !state.thresholdBlockedUntilInput
    )
      return
    persist(idleSafeCompactionState)
  })

  pi.on("session_before_compact", (event, ctx) => {
    latestCtx = ctx
    const transition = beforeCompactionTransition(
      state,
      event.reason,
      Date.now(),
    )
    persist(transition.state)
    if (
      transition.notifyPreparation &&
      transition.state.phase === "preparing"
    ) {
      sendPreparation(transition.state.reason)
    }
    if (event.reason === "overflow" && transition.state.phase === "forced") {
      pi.events.emit(SAFE_COMPACTION_INTERRUPT_EVENT, {
        reason: "overflow",
        expectedError: "This operation was aborted",
      })
      const latestUserRequest = latestBoundedUserRequest(event.branchEntries)
      return {
        compaction: {
          summary: overflowFallbackSummary(
            event.preparation.previousSummary,
            transition.state.resumeNotes,
            latestUserRequest,
          ),
          firstKeptEntryId: overflowRecoveryFirstKeptEntryId(
            event.branchEntries,
            event.preparation.firstKeptEntryId,
          ),
          tokensBefore: event.preparation.tokensBefore,
        },
      }
    }
    return transition.cancel ? { cancel: true } : undefined
  })

  pi.on("session_compact", (event, ctx) => {
    latestCtx = ctx
    compactRequested = false
    const completed = state
    if (completed.phase === "idle" || completed.phase === "preparing") {
      persist(
        completed.phase === "idle" && completed.thresholdBlockedUntilInput
          ? thresholdBlockedSafeCompactionState
          : idleSafeCompactionState,
      )
      return
    }
    const mode = compactionResumeMode(event.reason, event.willRetry)
    persist(
      mode === "manual-complete"
        ? idleSafeCompactionState
        : thresholdBlockedSafeCompactionState,
    )
    if (mode === "host-retry") {
      ctx.ui.notify(
        "Context restored after overflow; Pi is retrying the interrupted turn.",
        "info",
      )
      return
    }
    if (mode === "agent-settled") {
      if (completed.phase === "forced" && completed.suppressAutomaticResume)
        return
      pendingAutomaticResume = completed
      return
    }
    if (mode === "manual-complete") sendResume(completed)
  })

  pi.on("agent_settled", (_event, ctx) => {
    latestCtx = ctx
    if (pendingAutomaticResume) {
      const completed = pendingAutomaticResume
      pendingAutomaticResume = undefined
      sendResume(completed)
      return
    }
    if (state.phase !== "ready" || compactRequested) return
    compactRequested = true
    ctx.compact({
      customInstructions:
        "Preserve active goals, every pending or blocked todo, exact unfinished tool actions, verified evidence, decisions, and the safe-compaction resume notes. A tool call without a successful tool result was not executed.",
      onError: error => {
        compactRequested = false
        ctx.ui.notify(`Safe compaction failed: ${error.message}`, "error")
      },
    })
  })

  pi.on("session_shutdown", () => {
    pendingAutomaticResume = undefined
    latestCtx = undefined
  })

  pi.registerTool({
    name: "safe_compaction_ready",
    label: "Safe compaction ready",
    description:
      "Acknowledge that pre-compaction state is durable and provide exact bounded resume notes. Use only after reconciling goals, todos, and unfinished tool calls.",
    promptSnippet:
      "Confirm readiness for pending safe compaction after persisting critical state",
    promptGuidelines: [
      "Call safe_compaction_ready only after persisting critical state and naming the exact post-compaction next action.",
      "A displayed tool call without a successful tool result was not executed; include it in safe_compaction_ready resume notes when still required.",
    ],
    parameters: Type.Object({
      resumeNotes: Type.String({ minLength: 1, maxLength: MAX_RESUME_NOTES }),
    }),
    async execute(_toolCallId, params) {
      if (state.phase === "idle" && state.thresholdBlockedUntilInput) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Checkpoint already completed before the readiness acknowledgement; no duplicate compaction was scheduled.",
            },
          ],
          details: { outcome: "already-compacted" as const },
          terminate: true,
        }
      }
      if (state.phase !== "preparing") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No safe compaction preparation is pending.",
            },
          ],
          details: { outcome: "not-pending" as const },
        }
      }
      const resumeNotes = boundedNotes(params.resumeNotes)
      if (!resumeNotes) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Resume notes must contain meaningful text.",
            },
          ],
          details: { outcome: "invalid" as const },
        }
      }
      persist({
        phase: "ready",
        reason: state.reason,
        requestedAt: state.requestedAt,
        readyAt: Date.now(),
        resumeNotes,
      })
      return {
        content: [
          {
            type: "text" as const,
            text: "Checkpoint ready. Pi will summarize context after this turn settles.",
          },
        ],
        details: { outcome: "ready" as const },
        terminate: true,
      }
    },
  })
}
