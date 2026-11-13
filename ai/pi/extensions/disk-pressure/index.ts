import { statfsSync } from "node:fs"
import { tmpdir } from "node:os"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { isToolCallEventType } from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import { availableMemoryBytes } from "../shared/memory-capacity.ts"
import {
  RESOURCE_PREFLIGHT_REQUEST_EVENT,
  type ResourcePreflightRequest,
  type ResourcePreflightSnapshot,
} from "../shared/resource-preflight.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"

import {
  CRITICAL_FREE_BYTES,
  CRITICAL_FREE_MEMORY_BYTES,
  WARNING_FREE_BYTES,
  WARNING_FREE_MEMORY_BYTES,
  cleanupNewResultSymlinks,
  cleanupStalePiTempLogs,
  formatFreeBytes,
  isExpensiveCommand,
  resourcePressureDecision,
  resultSymlinkNames,
} from "./core.ts"

const STATUS_KEY = "disk-pressure"
type PendingBuild = {
  cwd: string
  resultLinksBefore: ReadonlySet<string>
}

const freeBytes: (path: string) => bigint = path => {
  const stats = statfsSync(path, { bigint: true })
  return stats.bavail * stats.bsize
}

const updateStatus: (
  ctx: ExtensionContext,
  diskAvailable: bigint,
  memoryAvailable: bigint,
) => void = (ctx, diskAvailable, memoryAvailable) => {
  const diskMarker =
    diskAvailable < CRITICAL_FREE_BYTES
      ? "!"
      : diskAvailable < WARNING_FREE_BYTES
        ? "~"
        : ""
  const memoryMarker =
    memoryAvailable < CRITICAL_FREE_MEMORY_BYTES
      ? "!"
      : memoryAvailable < WARNING_FREE_MEMORY_BYTES
        ? "~"
        : ""
  ctx.ui.setStatus(
    STATUS_KEY,
    `disk:${formatFreeBytes(diskAvailable)}${diskMarker} · mem:${formatFreeBytes(memoryAvailable)}${memoryMarker}`,
  )
}

export default (pi: ExtensionAPI) => {
  registerRuntimeVersion(pi, "resource-pressure", "2026.09.04.1")
  const pendingBuilds = new Map<string, PendingBuild>()
  const resourcePressureSnapshot = async (
    cwd: string,
    command: string,
  ): Promise<ResourcePreflightSnapshot | undefined> => {
    if (!isExpensiveCommand(command)) return undefined
    const diskAvailable = freeBytes(cwd)
    const memory = await Effect.runPromise(
      Effect.either(availableMemoryBytes()),
    )
    if (Either.isLeft(memory)) return undefined
    const memoryAvailable = memory.right
    const decision = resourcePressureDecision(
      command,
      diskAvailable,
      memoryAvailable,
    )
    return {
      verdict: decision.verdict,
      ...(decision.verdict === "block" ? { reason: decision.reason } : {}),
      diskAvailableBytes: String(diskAvailable),
      diskReserveBytes: String(CRITICAL_FREE_BYTES),
      memoryAvailableBytes: String(memoryAvailable),
      memoryReserveBytes: String(CRITICAL_FREE_MEMORY_BYTES),
      checkedAt: Date.now(),
    }
  }

  pi.events.on(
    RESOURCE_PREFLIGHT_REQUEST_EVENT,
    (request: ResourcePreflightRequest) => {
      void resourcePressureSnapshot(request.cwd, request.command).then(
        request.report,
        () => request.report(undefined),
      )
    },
  )

  pi.on("session_start", async (_event, ctx) => {
    try {
      const removed = cleanupStalePiTempLogs(tmpdir())
      const available = freeBytes(ctx.cwd)
      const memory = await Effect.runPromise(
        Effect.either(availableMemoryBytes()),
      )
      if (Either.isLeft(memory)) {
        const summary = `Resource-pressure check failed safely: ${memory.left.message}`
        ctx.ui.notify(summary, "warning")
        return
      }
      const memoryAvailable = memory.right
      updateStatus(ctx, available, memoryAvailable)
      if (removed.length > 0)
        ctx.ui.notify(
          `Cleaned ${removed.length} stale Pi temporary log${removed.length === 1 ? "" : "s"}.`,
        )
      if (available < CRITICAL_FREE_BYTES) {
        ctx.ui.notify(
          `Disk pressure critical: ${formatFreeBytes(available)} free. Expensive builds are blocked until space is recovered.`,
          "warning",
        )
      }
    } catch (error) {
      const summary = `Resource-pressure check failed safely: ${error instanceof Error ? error.message : "unknown error"}`
      ctx.ui.notify(summary, "warning")
    }
  })

  pi.on("tool_call", async (event, ctx) => {
    if (
      !isToolCallEventType("bash", event) ||
      !isExpensiveCommand(event.input.command)
    )
      return
    try {
      const available = freeBytes(ctx.cwd)
      const memory = await Effect.runPromise(
        Effect.either(availableMemoryBytes()),
      )
      if (Either.isLeft(memory)) {
        const summary = `Disk pressure guard could not verify safe build capacity: ${memory.left.message}`
        return { block: true, reason: `${summary}.` }
      }
      const memoryAvailable = memory.right
      updateStatus(ctx, available, memoryAvailable)
      const decision = resourcePressureDecision(
        event.input.command,
        available,
        memoryAvailable,
      )
      if (decision.verdict === "block") {
        return decision.reason === "disk pressure"
          ? {
              block: true,
              reason: `Disk pressure guard: only ${formatFreeBytes(available)} free; reserve ${formatFreeBytes(CRITICAL_FREE_BYTES)} before expensive builds. Follow standing exact cleanup authority: inspect candidate roots with dust or Nushell \`du\`, preserve configured live outputs, remove only verified inactive rebuildable or agent-owned artifacts, independently verify the exact path after uncertain execution, then continue the blocked gate. Do not poll repeatedly, delete unrelated data, or ask again for authority already granted.`,
            }
          : {
              block: true,
              reason: `Memory pressure guard: only ${formatFreeBytes(memoryAvailable)} available; reserve ${formatFreeBytes(CRITICAL_FREE_MEMORY_BYTES)} before expensive builds. Do not retry expensive work until capacity is recovered.`,
            }
      }
      pendingBuilds.set(event.toolCallId, {
        cwd: ctx.cwd,
        resultLinksBefore: resultSymlinkNames(ctx.cwd),
      })
    } catch (error) {
      const summary = `Disk pressure guard could not verify safe build capacity: ${error instanceof Error ? error.message : "unknown error"}`
      return {
        block: true,
        reason: `${summary}.`,
      }
    }
  })

  pi.on("tool_result", async (event, ctx) => {
    const pending = pendingBuilds.get(event.toolCallId)
    if (!pending) return
    pendingBuilds.delete(event.toolCallId)
    try {
      const removed = cleanupNewResultSymlinks(
        pending.cwd,
        pending.resultLinksBefore,
      )
      const available = freeBytes(ctx.cwd)
      const memory = await Effect.runPromise(
        Effect.either(availableMemoryBytes()),
      )
      if (Either.isLeft(memory)) {
        const summary = `Post-build cleanup failed safely: ${memory.left.message}`
        ctx.ui.notify(summary, "warning")
        return
      }
      const memoryAvailable = memory.right
      updateStatus(ctx, available, memoryAvailable)
      if (removed.length > 0) {
        ctx.ui.notify(
          `Cleaned agent-created Nix result link${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.`,
        )
      }
    } catch (error) {
      const summary = `Post-build cleanup failed safely: ${error instanceof Error ? error.message : "unknown error"}`
      ctx.ui.notify(summary, "warning")
    }
  })

  pi.on("session_shutdown", (_event, ctx) => {
    pendingBuilds.clear()
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
