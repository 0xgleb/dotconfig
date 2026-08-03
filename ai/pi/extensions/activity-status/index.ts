import { homedir } from "node:os"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { alignChromeLine } from "../shared/chrome.ts"
import {
  ACTIVITY_PHASE_EVENT,
  type ClassifierActivityEvent,
} from "../shared/activity-events.ts"
import {
  QUESTION_PENDING_COUNT_EVENT,
  type UserQuestionPendingCount,
} from "../shared/question-events.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import {
  assistantPhase,
  observeToolProgress,
  runningToolProgressPhase,
  startToolProgress,
  usageThrottleLabel,
  type ActivityPhase,
  type ToolProgress,
} from "./core.ts"

const STATUS_KEY = "activity-phase"
const TOOL_PROGRESS_WIDGET_KEY = "activity-tool-progress"
const TOOL_PROGRESS_TICK_MS = 1_000
const READY_LABEL = "READY · awaiting activity"

export default function activityStatus(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "activity-status", "2026.08.01.8")
  const runningTools = new Map<string, ToolProgress>()
  let latestCtx: ExtensionContext | undefined
  let classifierDepth = 0
  let pendingQuestionCount = 0
  let throttleLabel: string | undefined
  let progressTimer: ReturnType<typeof setInterval> | undefined

  const actionLabel = (): string =>
    pendingQuestionCount > 0
      ? `ACTION REQUIRED · ${pendingQuestionCount} question${pendingQuestionCount === 1 ? "" : "s"} · /questions`
      : READY_LABEL

  const questionLabel = (): string =>
    [throttleLabel, actionLabel()].filter(Boolean).join(" · ")

  const withQuestionLabel = (label: string): string => {
    const persistent = [
      throttleLabel,
      pendingQuestionCount > 0 ? actionLabel() : undefined,
    ].filter(Boolean)
    return persistent.length > 0 ? `${label} · ${persistent.join(" · ")}` : label
  }

  const show = (phase: ActivityPhase, ctx = latestCtx): void => {
    if (!ctx) return
    latestCtx = ctx
    ctx.ui.setWorkingMessage(phase.label)
    ctx.ui.setStatus(STATUS_KEY, phase.label)
  }

  const stopProgressTicker = (): void => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = undefined
  }

  const setProgressWidget = (label: string, ctx = latestCtx): void => {
    if (!ctx) return
    ctx.ui.setWidget(
      TOOL_PROGRESS_WIDGET_KEY,
      () => ({
        render: (width: number) => [alignChromeLine(label, width)],
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    )
  }

  const clearToolProgress = (ctx = latestCtx): void => {
    stopProgressTicker()
    setProgressWidget(questionLabel(), ctx)
  }

  const showRunningTools = (ctx = latestCtx): void => {
    if (!ctx) return
    const tools = [...runningTools.values()]
    const phase = runningToolProgressPhase(tools, Date.now())
    show(phase, ctx)
    if (tools.length > 0) {
      setProgressWidget(withQuestionLabel(phase.label), ctx)
    } else {
      setProgressWidget(questionLabel(), ctx)
    }
  }

  const startProgressTicker = (ctx: ExtensionContext): void => {
    if (progressTimer) return
    progressTimer = setInterval(() => {
      if (classifierDepth === 0 && runningTools.size > 0) showRunningTools(ctx)
    }, TOOL_PROGRESS_TICK_MS)
    progressTimer.unref()
  }

  pi.events.on(
    QUESTION_PENDING_COUNT_EVENT,
    ({ pending }: UserQuestionPendingCount) => {
      pendingQuestionCount = Math.max(0, pending)
      if (!latestCtx) return

      if (runningTools.size > 0) showRunningTools(latestCtx)
      else setProgressWidget(questionLabel(), latestCtx)
    },
  )

  pi.events.on(ACTIVITY_PHASE_EVENT, (event: ClassifierActivityEvent) => {
    classifierDepth = Math.max(0, classifierDepth + (event.active ? 1 : -1))
    if (event.active) {
      show({
        kind: "classifier",
        label: `CLASSIFIER · ${event.boundary} · model generation · ${event.subject}`,
      })
    } else if (classifierDepth === 0) {
      showRunningTools()
    }
  })

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx
    runningTools.clear()
    classifierDepth = 0
    throttleLabel = usageThrottleLabel(ctx.cwd, homedir(), ctx.model?.provider)
    clearToolProgress(ctx)
    ctx.ui.setStatus(STATUS_KEY, throttleLabel)
    ctx.ui.setWorkingMessage()
  })

  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx
    runningTools.clear()
    throttleLabel = usageThrottleLabel(ctx.cwd, homedir(), ctx.model?.provider)
    clearToolProgress(ctx)
    show({ kind: "model", label: "MODEL · awaiting generation" }, ctx)
  })

  pi.on("turn_start", (_event, ctx) => {
    if (runningTools.size === 0 && classifierDepth === 0)
      show({ kind: "model", label: "MODEL · generating" }, ctx)
  })

  pi.on("message_update", (event, ctx) => {
    if (
      classifierDepth > 0 ||
      runningTools.size > 0 ||
      event.message.role !== "assistant"
    )
      return
    const phase = assistantPhase(event.message)
    if (phase) show(phase, ctx)
  })

  pi.on("tool_execution_start", (event, ctx) => {
    runningTools.set(
      event.toolCallId,
      startToolProgress(event.toolName, Date.now()),
    )
    startProgressTicker(ctx)
    if (classifierDepth === 0) showRunningTools(ctx)
  })

  pi.on("tool_execution_update", (event, ctx) => {
    const progress =
      runningTools.get(event.toolCallId) ??
      startToolProgress(event.toolName, Date.now())
    runningTools.set(
      event.toolCallId,
      observeToolProgress(progress, event.partialResult),
    )
    if (classifierDepth === 0) showRunningTools(ctx)
  })

  pi.on("tool_execution_end", (event, ctx) => {
    runningTools.delete(event.toolCallId)
    if (runningTools.size === 0) stopProgressTicker()
    if (classifierDepth === 0) showRunningTools(ctx)
  })

  pi.on("session_before_compact", (_event, ctx) => {
    show(
      { kind: "compacting", label: "COMPACTING · preparing durable summary" },
      ctx,
    )
  })

  pi.on("session_compact", (_event, ctx) => {
    show({ kind: "model", label: "MODEL · resuming after compaction" }, ctx)
  })

  pi.on("agent_end", (_event, ctx) => {
    runningTools.clear()
    classifierDepth = 0
    clearToolProgress(ctx)
    ctx.ui.setStatus(STATUS_KEY, throttleLabel)
    ctx.ui.setWorkingMessage()
  })

  pi.on("session_shutdown", (_event, ctx) => {
    runningTools.clear()
    clearToolProgress(ctx)
    ctx.ui.setStatus(STATUS_KEY, undefined)
    ctx.ui.setWorkingMessage()
    throttleLabel = undefined
    latestCtx = undefined
  })
}
