import { createHash } from "node:crypto"
import {
  globSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
  type Stats,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import * as Effect from "effect/Effect"

import {
  HANDOFF_GLOBS,
  isSafeHandoffName,
  managedPiChangeLabel,
  latestReloadResumeMarker,
  managedPiWatchPaths,
  managedReloadDecision,
  managedReloadDelivery,
  managedReloadDisplayText,
  parseManagedReloadSummary,
  parseSeenHandoffNames,
  RELOAD_FOLLOW_UP_ENTRY,
  RELOAD_RESUME_ENTRY,
  reloadComposerIsSafe,
  unseenHandoffNames,
} from "./core.ts"
import { AGENTOPS_INCIDENT_EVENT } from "../shared/agentops-events.ts"
import { isContinuationPaused } from "../shared/continuation-pause.ts"
import {
  AUTO_RELOAD_ACTIVITY_REQUEST_EVENT,
  AUTO_RELOAD_PENDING_REQUEST_EVENT,
  MANUAL_RELOAD_REQUEST_EVENT,
  type AutoReloadActivityReporter,
  type AutoReloadPendingReporter,
} from "../shared/reload-events.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import {
  HOST_MIGRATION_DRAFT_ENV,
  HOST_MIGRATION_RESUME_ENV,
  hostMigrationArgv,
  hostMigrationEnvironment,
  isInteractiveHostRuntime,
  needsManagedHostMigration,
  piPackageRoot,
  verifiedHostArtifacts,
} from "./host-migration.ts"

const HANDOFF_POLL_MS = 60 * 60 * 1_000
const COMPLETED_MESSAGE_TYPE = "auto-reload.completed"
const HANDOFF_STATE_ENTRY = "auto-reload.seen-pi-handoffs"
const RELOAD_SUMMARY_ENTRY = "auto-reload.managed-change-summary"
const IDLE_RETRY_MS = 1_000
const SETTLE_RETRY_MS = 2_000
const SETTLE_MS = 15_000
const COMPOSER_QUIET_MS = 2_000
const GENERATION_POLL_MS = 5_000
const GENERATION_RECONCILE_MS = SETTLE_RETRY_MS
const MODEL_REFRESH_TIMEOUT_MS = 10_000
const HOST_MIGRATION_RETRY_MS = 250
const STATUS_KEY = "auto-reload"

interface HostMigrationPlan {
  readonly stableEntrypoint: string
  readonly sessionFile: string
}

interface ReloadableContext extends ExtensionContext {
  reload(): Promise<void>
}

const isReloadableContext: (
  ctx: ExtensionContext,
) => ctx is ReloadableContext = ctx =>
  "reload" in ctx && typeof ctx.reload === "function"

export type ManagedGenerationChange = "unchanged" | "content-changed"

export interface ManagedGenerationTracker {
  reconcile(): ManagedGenerationChange
}

export interface ManagedGenerationReconciler {
  request(changedPath: string | null): void
  poll(changedPath: string | null): void
  close(): void
}

export interface ReloadExecutionScheduler<Context> {
  request(ctx: Context): void
  close(): void
}

export const createReloadExecutionScheduler = <Context>(
  reload: (ctx: Context) => Promise<void>,
): ReloadExecutionScheduler<Context> => {
  let scheduled: { readonly timer: ReturnType<typeof setTimeout> } | undefined

  return {
    request(ctx) {
      if (scheduled) return
      const timer = setTimeout(() => {
        scheduled = undefined
        void reload(ctx)
      }, 0)
      timer.unref?.()
      scheduled = { timer }
    },
    close() {
      if (scheduled) clearTimeout(scheduled.timer)
      scheduled = undefined
    },
  }
}

export const managedGeneration = (roots: readonly string[]): string =>
  managedTreeGeneration(
    roots,
    candidate =>
      `${candidate}:${createHash("sha256").update(readFileSync(candidate)).digest("hex")}`,
  )

export const managedMetadataGeneration = (roots: readonly string[]): string =>
  managedTreeGeneration(
    roots,
    (candidate, stat) =>
      `${candidate}:${stat.mtimeMs}:${stat.size}:${stat.mode}`,
  )

export const createManagedGenerationTracker = (
  roots: readonly string[],
  operations: {
    readonly metadataGeneration: (roots: readonly string[]) => string
    readonly contentGeneration: (roots: readonly string[]) => string
  } = {
    metadataGeneration: managedMetadataGeneration,
    contentGeneration: managedGeneration,
  },
): ManagedGenerationTracker => {
  let metadataGeneration = operations.metadataGeneration(roots)
  let contentGeneration = operations.contentGeneration(roots)

  return {
    reconcile: () => {
      const nextMetadataGeneration = operations.metadataGeneration(roots)
      if (nextMetadataGeneration === metadataGeneration) return "unchanged"
      metadataGeneration = nextMetadataGeneration

      const nextContentGeneration = operations.contentGeneration(roots)
      if (nextContentGeneration === contentGeneration) return "unchanged"
      contentGeneration = nextContentGeneration
      return "content-changed"
    },
  }
}

export const createManagedGenerationReconciler = (input: {
  readonly tracker: ManagedGenerationTracker
  readonly settleMs: number
  readonly onContentChange: (changedPath: string | null) => void
}): ManagedGenerationReconciler => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let latestChangedPath: string | null = null

  const reconcile = () => {
    timer = undefined
    const changedPath = latestChangedPath
    latestChangedPath = null
    if (input.tracker.reconcile() === "content-changed")
      input.onContentChange(changedPath)
  }

  return {
    request: changedPath => {
      latestChangedPath = changedPath ?? latestChangedPath
      if (timer) clearTimeout(timer)
      timer = setTimeout(reconcile, input.settleMs)
      timer.unref?.()
    },
    poll: changedPath => {
      if (timer) return
      latestChangedPath = changedPath
      reconcile()
    },
    close: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      latestChangedPath = null
    },
  }
}

const reloadDisplayDetails = (
  value: unknown,
): { readonly displayText: string } | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("displayText" in value) ||
    typeof value.displayText !== "string"
  )
    return undefined
  return { displayText: value.displayText }
}

const managedTreeGeneration = (
  roots: readonly string[],
  fileRecord: (candidate: string, stat: Stats) => string,
): string => {
  const records: string[] = []
  const visit = (candidate: string) => {
    try {
      const stat = lstatSync(candidate)
      if (!stat.isDirectory()) {
        records.push(fileRecord(candidate, stat))
        return
      }
      records.push(`${candidate}:directory`)
      for (const name of readdirSync(candidate)) {
        if (name === "node_modules" || name === "brave-operator-profile")
          continue
        visit(join(candidate, name))
      }
    } catch {
      records.push(`${candidate}:missing`)
    }
  }
  roots.forEach(visit)
  return records.sort().join("\n")
}

const autoReload: (pi: ExtensionAPI) => void = pi => {
  registerRuntimeVersion(pi, "auto-reload", "2026.09.04.1")
  pi.registerMessageRenderer(
    COMPLETED_MESSAGE_TYPE,
    (message, options, theme) => {
      const displayText =
        reloadDisplayDetails(message.details)?.displayText ??
        String(message.content)
      return new Text(
        theme.fg("accent", theme.bold(displayText)),
        options.outputPad,
        0,
      )
    },
  )
  const reportIncident = (
    severity: "error" | "warning",
    operation: string,
    summary: string,
  ): void => {
    pi.events.emit(AGENTOPS_INCIDENT_EVENT, {
      severity,
      component: "auto-reload",
      operation,
      summary,
    })
  }
  let watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let handoffTimer: ReturnType<typeof setInterval> | undefined
  let generationTimer: ReturnType<typeof setInterval> | undefined
  let reloadContinuationTimer: ReturnType<typeof setTimeout> | undefined
  let hostMigrationTimer: ReturnType<typeof setTimeout> | undefined
  let generationReconciler: ManagedGenerationReconciler | undefined
  let reloadExecutionScheduler:
    ReloadExecutionScheduler<ReloadableContext> | undefined
  let agentRunActive = false
  let pending = false
  let pendingSince: number | undefined
  let composerSafeSince: number | undefined
  let lastChangeAt = 0
  const changedLabels = new Set<string>()

  pi.events.on(
    AUTO_RELOAD_PENDING_REQUEST_EVENT,
    (report: AutoReloadPendingReporter) => report(pending),
  )

  pi.events.on(MANUAL_RELOAD_REQUEST_EVENT, () => {
    if (timer) clearTimeout(timer)
    reloadExecutionScheduler?.close()
    timer = undefined
    if (changedLabels.size > 0) {
      pi.appendEntry(RELOAD_SUMMARY_ENTRY, {
        labels: [...changedLabels].sort(),
        createdAt: Date.now(),
        announced: false,
      })
      changedLabels.clear()
    }
    pending = false
    pendingSince = undefined
    composerSafeSince = undefined
  })

  const resolveHostMigrationPlan = (
    ctx: ExtensionContext,
  ): HostMigrationPlan | undefined => {
    const currentEntrypoint = process.argv[1]
    const sessionFile = ctx.sessionManager.getSessionFile()
    if (
      !isInteractiveHostRuntime({
        mode: ctx.mode,
        stdinIsTTY: process.stdin.isTTY,
        stdoutIsTTY: process.stdout.isTTY,
      }) ||
      !currentEntrypoint ||
      !sessionFile
    )
      return undefined

    const stablePiPath = join(homedir(), ".pi", "agent", "bin", "pi")
    try {
      const stableEntrypoint = realpathSync(stablePiPath)
      if (
        !needsManagedHostMigration({
          currentEntrypoint,
          stableEntrypoint,
        })
      )
        return undefined
      const stableRoot = piPackageRoot(stableEntrypoint)
      const expectedWrappedEntrypoint = join(stableRoot, "bin", ".pi-wrapped")
      const tuiRoot = join(
        stableRoot,
        "lib",
        "node_modules",
        "pi-monorepo",
        "node_modules",
        "@earendil-works",
        "pi-tui",
        "dist",
      )
      const verified = verifiedHostArtifacts({
        launcher: readFileSync(stableEntrypoint, "utf8"),
        expectedWrappedEntrypoint,
        tui: readFileSync(join(tuiRoot, "tui.js"), "utf8"),
        mainScreen: readFileSync(join(tuiRoot, "tui-main-screen.js"), "utf8"),
      })
      if (!verified) {
        reportIncident(
          "error",
          "verify replacement Pi host",
          "Stable Pi host rejected before migration: stable host markers do not match",
        )
        return undefined
      }
      return { stableEntrypoint, sessionFile }
    } catch (error) {
      reportIncident(
        "error",
        "verify replacement Pi host",
        `Could not verify the activated Pi host for live migration: ${error instanceof Error ? error.message : "unknown error"}`,
      )
      return undefined
    }
  }

  const scheduleHostMigration = (
    ctx: ExtensionContext,
    plan: HostMigrationPlan,
  ): void => {
    const migrateWhenIdle = (): void => {
      hostMigrationTimer = undefined
      if (agentRunActive || !ctx.isIdle() || ctx.hasPendingMessages()) {
        hostMigrationTimer = setTimeout(
          migrateWhenIdle,
          HOST_MIGRATION_RETRY_MS,
        )
        hostMigrationTimer.unref?.()
        return
      }
      const editorDraft = ctx.ui.getEditorText()
      const delivery = managedReloadDelivery(
        "reload",
        ctx.sessionManager.getBranch(),
        false,
      )
      try {
        process.execve(
          plan.stableEntrypoint,
          hostMigrationArgv(plan.stableEntrypoint, plan.sessionFile),
          hostMigrationEnvironment(
            process.env,
            editorDraft,
            delivery === "resume" || delivery === "followUp",
          ),
        )
      } catch (error) {
        reportIncident(
          "error",
          "replace running Pi host",
          `Could not replace the running Pi host: ${error instanceof Error ? error.message : "unknown error"}`,
        )
        ctx.ui.setStatus(STATUS_KEY, "reload:host-migration-failed")
      }
    }

    ctx.ui.setStatus(STATUS_KEY, "reload:restarting-host")
    hostMigrationTimer = setTimeout(migrateWhenIdle, 0)
    hostMigrationTimer.unref?.()
  }

  const restoreHostMigration = (ctx: ExtensionContext): void => {
    const editorDraft = process.env[HOST_MIGRATION_DRAFT_ENV]
    const shouldResume = process.env[HOST_MIGRATION_RESUME_ENV] === "1"
    delete process.env[HOST_MIGRATION_DRAFT_ENV]
    delete process.env[HOST_MIGRATION_RESUME_ENV]
    if (editorDraft === undefined) return
    ctx.ui.setEditorText(editorDraft)
    if (!shouldResume || editorDraft.length > 0) return

    const resumeWhenIdle = (): void => {
      hostMigrationTimer = undefined
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        hostMigrationTimer = setTimeout(resumeWhenIdle, HOST_MIGRATION_RETRY_MS)
        hostMigrationTimer.unref?.()
        return
      }
      pi.sendMessage(
        {
          customType: "auto-reload.host-migrated",
          content: "Resuming preserved work after Pi host migration.",
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      )
    }
    hostMigrationTimer = setTimeout(resumeWhenIdle, 0)
    hostMigrationTimer.unref?.()
  }

  const closeWatchers = () => {
    if (timer) clearTimeout(timer)
    if (handoffTimer) clearInterval(handoffTimer)
    if (generationTimer) clearInterval(generationTimer)
    if (reloadContinuationTimer) clearTimeout(reloadContinuationTimer)
    if (hostMigrationTimer) clearTimeout(hostMigrationTimer)
    generationReconciler?.close()
    reloadExecutionScheduler?.close()
    timer = undefined
    handoffTimer = undefined
    generationTimer = undefined
    reloadContinuationTimer = undefined
    hostMigrationTimer = undefined
    generationReconciler = undefined
    agentRunActive = false
    pending = false
    pendingSince = undefined
    composerSafeSince = undefined
    lastChangeAt = 0
    changedLabels.clear()
    for (const watcher of watchers) watcher.close()
    watchers = []
  }

  const performReload = async (ctx: ReloadableContext) => {
    if (!pending) return
    // Scheduling is asynchronous. A new turn, draft, queued prompt, workflow,
    // or compaction can start after the idle decision. Recheck every surface
    // before invalidating the runtime; automatic reload never owns the editor.
    const managedWorkActive = managedWorkIsActive()
    const composerSafe = reloadComposerIsSafe({
      editorText: ctx.ui.getEditorText(),
      pendingMessages: ctx.hasPendingMessages(),
      compactionActive: managedWorkActive,
    })
    if (
      agentRunActive ||
      !ctx.isIdle() ||
      !composerSafe ||
      composerSafeSince === undefined ||
      Date.now() - composerSafeSince < COMPOSER_QUIET_MS
    ) {
      if (!composerSafe) composerSafeSince = undefined
      timer = setTimeout(() => void reloadWhenIdle(ctx), IDLE_RETRY_MS)
      return
    }
    pending = false
    pendingSince = undefined
    composerSafeSince = undefined
    if (timer) clearTimeout(timer)
    timer = undefined
    ctx.ui.setStatus(STATUS_KEY, undefined)
    if (changedLabels.size > 0) {
      pi.appendEntry(RELOAD_SUMMARY_ENTRY, {
        labels: [...changedLabels].sort(),
        createdAt: Date.now(),
        announced: false,
      })
      changedLabels.clear()
    }
    try {
      await ctx.reload()
    } catch (error) {
      reportIncident(
        "error",
        "automatic extension reload",
        `Automatic Pi reload failed: ${error instanceof Error ? error.message : "unknown error"}`,
      )
      pending = true
      pendingSince = Date.now()
      composerSafeSince = undefined
    }
  }

  reloadExecutionScheduler = createReloadExecutionScheduler(performReload)

  const managedWorkIsActive = (): boolean => {
    let active = false
    const reportActivity: AutoReloadActivityReporter = reported => {
      active ||= reported
    }
    pi.events.emit(AUTO_RELOAD_ACTIVITY_REQUEST_EVENT, reportActivity)
    return active
  }

  const reloadWhenIdle = async (ctx: ReloadableContext) => {
    if (!pending) return
    const now = Date.now()
    const managedWorkActive = managedWorkIsActive()
    const composerSafe = reloadComposerIsSafe({
      editorText: ctx.ui.getEditorText(),
      pendingMessages: ctx.hasPendingMessages(),
      compactionActive: managedWorkActive,
    })
    if (!composerSafe) composerSafeSince = undefined
    else composerSafeSince ??= now
    const composerQuiet =
      composerSafe &&
      composerSafeSince !== undefined &&
      now - composerSafeSince >= COMPOSER_QUIET_MS
    const decision = managedReloadDecision({
      settled: now - lastChangeAt >= SETTLE_MS,
      idle: !agentRunActive && ctx.isIdle() && composerQuiet,
      pendingForMs: Math.max(0, now - (pendingSince ?? now)),
      forceAfterMs: Number.POSITIVE_INFINITY,
      preemptRequested: false,
    })
    if (decision === "await-settle") {
      ctx.ui.setStatus(STATUS_KEY, "reload:awaiting-settle")
      timer = setTimeout(() => void reloadWhenIdle(ctx), SETTLE_RETRY_MS)
      return
    }
    if (decision === "wait") {
      ctx.ui.setStatus(
        STATUS_KEY,
        composerSafe ? "reload:waiting-for-quiet" : "reload:waiting-for-editor",
      )
      timer = setTimeout(() => void reloadWhenIdle(ctx), IDLE_RETRY_MS)
      return
    }
    reloadExecutionScheduler.request(ctx)
  }

  const scheduleReload = (
    ctx: ReloadableContext,
    changedPath: string | null,
    aiRoot: string,
  ) => {
    if (
      changedPath?.includes("node_modules") ||
      changedPath?.includes("brave-operator-profile")
    )
      return
    if (changedPath)
      changedLabels.add(managedPiChangeLabel(changedPath, aiRoot))
    lastChangeAt = Date.now()
    if (!pending) pendingSince = Date.now()
    pending = true
    composerSafeSince = undefined
    ctx.ui.setStatus(STATUS_KEY, "reload:pending")
    if (timer) clearTimeout(timer)
    timer = undefined
    queueMicrotask(() => void reloadWhenIdle(ctx))
  }

  pi.on("session_start", async (event, ctx) => {
    closeWatchers()
    restoreHostMigration(ctx)
    const branch = ctx.sessionManager.getBranch()
    const hostMigrationPlan = resolveHostMigrationPlan(ctx)
    const summaryEntry = branch
      .filter(
        entry =>
          entry.type === "custom" && entry.customType === RELOAD_SUMMARY_ENTRY,
      )
      .at(-1)
    const summary =
      summaryEntry?.type === "custom"
        ? parseManagedReloadSummary(summaryEntry.data)
        : undefined
    let modelRefreshFailure: string | undefined
    if (event.reason === "reload" && ctx.model) {
      const activeModel = ctx.model
      const refreshAttempt = await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            ctx.modelRegistry.refresh({
              allowNetwork: false,
              providers: [activeModel.provider],
              signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
            }),
          catch: () => new Error("model catalog refresh threw"),
        }).pipe(Effect.either),
      )
      if (refreshAttempt._tag === "Left") {
        modelRefreshFailure = "model catalog refresh failed"
      } else if (refreshAttempt.right.aborted) {
        modelRefreshFailure = "model catalog refresh timed out"
      } else if (
        refreshAttempt.right.errors.size > 0 ||
        ctx.modelRegistry.getError()
      ) {
        modelRefreshFailure = "model catalog refresh returned errors"
      } else {
        const refreshedModel = ctx.modelRegistry.find(
          activeModel.provider,
          activeModel.id,
        )
        if (!refreshedModel) {
          modelRefreshFailure = `active model ${activeModel.provider}/${activeModel.id} disappeared after refresh`
        } else {
          const selectionAttempt = await Effect.runPromise(
            Effect.tryPromise({
              try: async () => await pi.setModel(refreshedModel),
              catch: () => new Error("refreshed model selection threw"),
            }).pipe(Effect.either),
          )
          if (selectionAttempt._tag === "Left" || !selectionAttempt.right) {
            modelRefreshFailure = `active model ${activeModel.provider}/${activeModel.id} could not be rebound`
          }
        }
      }
    }
    if (event.reason === "reload" && !hostMigrationPlan) {
      const changedLabels = summary && !summary.announced ? summary.labels : []
      const delivery = managedReloadDelivery(
        event.reason,
        branch,
        ctx.hasPendingMessages(),
      )
      const displayText = managedReloadDisplayText(
        changedLabels,
        modelRefreshFailure,
      )
      const message = {
        customType: COMPLETED_MESSAGE_TYPE,
        content: modelRefreshFailure
          ? `${displayText}. Preserved work remains paused to avoid stale model limits.`
          : delivery === "resume"
            ? `${displayText}. Resuming interrupted work.`
            : delivery === "followUp"
              ? `${displayText}. Resuming preserved work now.`
              : displayText,
        display: true,
        details: { displayText },
      }
      const scheduleContinuation = (deliverAs: "resume" | "followUp"): void => {
        const deliverWhenSettled = (): void => {
          reloadContinuationTimer = undefined
          const requestedAt =
            latestReloadResumeMarker(branch)?.requestedAt ?? Date.now()
          const recordDelivery = (): void => {
            if (deliverAs === "resume") {
              pi.appendEntry(RELOAD_RESUME_ENTRY, {
                requestedAt,
                status: "resumed",
              })
            } else {
              pi.appendEntry(RELOAD_FOLLOW_UP_ENTRY, { requestedAt })
            }
          }
          if (ctx.ui.getEditorText().length > 0 || ctx.hasPendingMessages()) {
            recordDelivery()
            try {
              pi.sendMessage(message, { deliverAs: "nextTurn" })
            } catch {
              reportIncident(
                "warning",
                "defer reload continuation",
                "Reload continuation could not be queued passively; user input remains available",
              )
            }
            return
          }
          if (agentRunActive || !ctx.isIdle() || managedWorkIsActive()) {
            reloadContinuationTimer = setTimeout(
              deliverWhenSettled,
              IDLE_RETRY_MS,
            )
            reloadContinuationTimer.unref?.()
            return
          }
          recordDelivery()
          try {
            pi.sendMessage(message, { triggerTurn: true, deliverAs })
          } catch {
            reportIncident(
              "warning",
              "deliver reload continuation",
              "Reload continuation delivery failed without blocking user input",
            )
          }
        }
        reloadContinuationTimer = setTimeout(deliverWhenSettled, 0)
        reloadContinuationTimer.unref?.()
      }
      if (modelRefreshFailure) {
        reportIncident(
          "error",
          "refresh model catalog after reload",
          modelRefreshFailure,
        )
        pi.sendMessage(message)
        ctx.ui.notify(modelRefreshFailure, "error")
      } else if (delivery === "resume") {
        scheduleContinuation("resume")
      } else if (delivery === "followUp") {
        scheduleContinuation("followUp")
      } else {
        if (delivery === "displayAndConsumeResume") {
          const requestedAt = latestReloadResumeMarker(branch)?.requestedAt
          if (requestedAt !== undefined)
            pi.appendEntry(RELOAD_RESUME_ENTRY, {
              requestedAt,
              status: "resumed",
            })
        }
        pi.sendMessage(message)
      }
      if (summary && !summary.announced) {
        pi.appendEntry(RELOAD_SUMMARY_ENTRY, { ...summary, announced: true })
      }
    }
    if (event.reason === "reload" && hostMigrationPlan) {
      pi.sendMessage({
        customType: "auto-reload.host-migration",
        content:
          "Activated Pi host verified; replacing this running process in place.",
        display: true,
      })
      if (summary && !summary.announced) {
        pi.appendEntry(RELOAD_SUMMARY_ENTRY, { ...summary, announced: true })
      }
    }
    if (hostMigrationPlan) {
      scheduleHostMigration(ctx, hostMigrationPlan)
      return
    }
    if (!isReloadableContext(ctx)) {
      const summary =
        "Automatic Pi reload requires the managed reload-context host patch"
      reportIncident("warning", "reload context preflight", summary)
      ctx.ui.notify(
        "Automatic Pi reload requires the managed reload-context host patch; restart after applying the Nix generation.",
        "warning",
      )
      return
    }
    const configRoot = join(homedir(), ".config")
    const aiRoot = join(configRoot, "ai")
    const watchPaths = managedPiWatchPaths(aiRoot)
    generationReconciler = createManagedGenerationReconciler({
      tracker: createManagedGenerationTracker(watchPaths),
      settleMs: GENERATION_RECONCILE_MS,
      onContentChange: changedPath => scheduleReload(ctx, changedPath, aiRoot),
    })
    for (const path of watchPaths) {
      try {
        const recursive = statSync(path).isDirectory()
        watchers.push(
          watch(path, { recursive }, (_eventType, filename) =>
            generationReconciler?.request(
              recursive && filename ? join(path, String(filename)) : path,
            ),
          ),
        )
      } catch (error) {
        const summary = `Could not watch managed Pi path: ${error instanceof Error ? error.message : "unknown error"}`
        reportIncident("warning", "watch managed Pi resources", summary)
        ctx.ui.notify(
          `Could not watch ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
          "warning",
        )
      }
    }

    generationTimer = setInterval(() => {
      generationReconciler?.poll(aiRoot)
      if (hostMigrationTimer) return
      const hostMigrationPlan = resolveHostMigrationPlan(ctx)
      if (hostMigrationPlan) scheduleHostMigration(ctx, hostMigrationPlan)
    }, GENERATION_POLL_MS)
    generationTimer.unref?.()

    ctx.ui.setStatus(STATUS_KEY, "reload:auto")

    if (ctx.cwd === configRoot) {
      ctx.ui.setStatus(STATUS_KEY, "reload:auto · requests:hourly")
      const handoffRoot = join(configRoot, ".tmp")
      try {
        const storedEntry = ctx.sessionManager
          .getBranch()
          .filter(
            entry =>
              entry.type === "custom" &&
              entry.customType === HANDOFF_STATE_ENTRY,
          )
          .at(-1)
        const persisted =
          storedEntry?.type === "custom"
            ? parseSeenHandoffNames(storedEntry.data)
            : []
        const current = globSync(HANDOFF_GLOBS, { cwd: handoffRoot }).filter(
          isSafeHandoffName,
        )
        const seen = new Set(storedEntry ? persisted : current)
        if (!storedEntry)
          pi.appendEntry(HANDOFF_STATE_ENTRY, { names: [...seen].sort() })

        const reconcileHandoffs = () => {
          if (isContinuationPaused(ctx.sessionManager.getBranch())) return
          const unseen = unseenHandoffNames(
            globSync(HANDOFF_GLOBS, { cwd: handoffRoot }),
            seen,
          )
          if (unseen.length === 0) return
          for (const name of unseen) seen.add(name)
          pi.appendEntry(HANDOFF_STATE_ENTRY, { names: [...seen].sort() })
          pi.sendMessage(
            {
              customType: "auto-reload.pi-handoff",
              content: `New Pi bug handoff${unseen.length === 1 ? "" : "s"}:\n${unseen.map(name => join(handoffRoot, name)).join("\n")}\nRead each file, add every request to the todo list, and continue the work.`,
              display: true,
            },
            { deliverAs: "followUp" },
          )
        }

        reconcileHandoffs()
        watchers.push(
          watch(handoffRoot, { recursive: true }, (_eventType, filename) => {
            if (!filename || !isSafeHandoffName(filename)) return
            reconcileHandoffs()
          }),
        )
        handoffTimer = setInterval(reconcileHandoffs, HANDOFF_POLL_MS)
        handoffTimer.unref?.()
      } catch (error) {
        const summary = `Could not watch Pi handoffs: ${error instanceof Error ? error.message : "unknown error"}`
        reportIncident("warning", "watch Pi handoffs", summary)
        ctx.ui.notify(summary, "warning")
      }
    }
  })

  pi.on("agent_start", () => {
    agentRunActive = true
  })

  pi.on("agent_end", async (_event, ctx) => {
    agentRunActive = false
    if (!pending || !isReloadableContext(ctx)) return
    if (Date.now() - lastChangeAt < SETTLE_MS) return
    await reloadWhenIdle(ctx)
  })

  pi.on("agent_settled", async (_event, ctx) => {
    agentRunActive = false
    if (!pending || !isReloadableContext(ctx)) return
    await reloadWhenIdle(ctx)
  })

  pi.on("session_shutdown", (_event, ctx) => {
    closeWatchers()
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}

export default autoReload
