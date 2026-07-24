import { statfsSync } from "node:fs";
import { freemem, tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";

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
} from "./core.ts";

const STATUS_KEY = "disk-pressure";

type PendingBuild = {
  cwd: string;
  resultLinksBefore: ReadonlySet<string>;
};

const freeBytes: (path: string) => bigint = (path) => {
  const stats = statfsSync(path, { bigint: true });
  return stats.bavail * stats.bsize;
};

const updateStatus: (ctx: ExtensionContext, diskAvailable: bigint, memoryAvailable: bigint) => void = (
  ctx,
  diskAvailable,
  memoryAvailable,
) => {
  const diskMarker = diskAvailable < CRITICAL_FREE_BYTES ? "!" : diskAvailable < WARNING_FREE_BYTES ? "~" : "";
  const memoryMarker =
    memoryAvailable < CRITICAL_FREE_MEMORY_BYTES ? "!" : memoryAvailable < WARNING_FREE_MEMORY_BYTES ? "~" : "";
  ctx.ui.setStatus(
    STATUS_KEY,
    `disk:${formatFreeBytes(diskAvailable)}${diskMarker} · mem:${formatFreeBytes(memoryAvailable)}${memoryMarker}`,
  );
};

const freeMemoryBytes = (): bigint => BigInt(freemem());

export default (pi: ExtensionAPI) => {
  registerRuntimeVersion(pi, "resource-pressure", "2026.07.23.1");
  const pendingBuilds = new Map<string, PendingBuild>();

  pi.on("session_start", (_event, ctx) => {
    try {
      const removed = cleanupStalePiTempLogs(tmpdir());
      const available = freeBytes(ctx.cwd);
      const memoryAvailable = freeMemoryBytes();
      updateStatus(ctx, available, memoryAvailable);
      if (removed.length > 0) ctx.ui.notify(`Cleaned ${removed.length} stale Pi temporary log${removed.length === 1 ? "" : "s"}.`);
      if (available < CRITICAL_FREE_BYTES) {
        ctx.ui.notify(
          `Disk pressure critical: ${formatFreeBytes(available)} free. Expensive builds are blocked until space is recovered.`,
          "warning",
        );
      }
      if (memoryAvailable < CRITICAL_FREE_MEMORY_BYTES) {
        ctx.ui.notify(
          `Memory pressure critical: ${formatFreeBytes(memoryAvailable)} free. Expensive builds and new workflow agents are blocked to preserve the crash reserve.`,
          "warning",
        );
      }
    } catch (error) {
      ctx.ui.notify(`Disk-pressure check failed safely: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
    }
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event) || !isExpensiveCommand(event.input.command)) return;
    try {
      const available = freeBytes(ctx.cwd);
      const memoryAvailable = freeMemoryBytes();
      updateStatus(ctx, available, memoryAvailable);
      const decision = resourcePressureDecision(event.input.command, available, memoryAvailable);
      if (decision.verdict === "block") {
        return decision.reason === "disk pressure"
          ? {
              block: true,
              reason: `Disk pressure guard: only ${formatFreeBytes(available)} free; reserve ${formatFreeBytes(CRITICAL_FREE_BYTES)} before expensive builds. Clean agent-owned artifacts or explicitly authorize broader cache cleanup.`,
            }
          : {
              block: true,
              reason: `Memory pressure guard: only ${formatFreeBytes(memoryAvailable)} free; reserve ${formatFreeBytes(CRITICAL_FREE_MEMORY_BYTES)} before expensive builds. Close or restart high-memory user applications before retrying; do not poll repeatedly.`,
            };
      }
      pendingBuilds.set(event.toolCallId, { cwd: ctx.cwd, resultLinksBefore: resultSymlinkNames(ctx.cwd) });
    } catch (error) {
      return {
        block: true,
        reason: `Disk pressure guard could not verify safe build capacity: ${error instanceof Error ? error.message : "unknown error"}.`,
      };
    }
  });

  pi.on("tool_result", (event, ctx) => {
    const pending = pendingBuilds.get(event.toolCallId);
    if (!pending) return;
    pendingBuilds.delete(event.toolCallId);
    try {
      const removed = cleanupNewResultSymlinks(pending.cwd, pending.resultLinksBefore);
      const available = freeBytes(ctx.cwd);
      updateStatus(ctx, available, freeMemoryBytes());
      if (removed.length > 0) {
        ctx.ui.notify(`Cleaned agent-created Nix result link${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.`);
      }
    } catch (error) {
      ctx.ui.notify(`Post-build cleanup failed safely: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    pendingBuilds.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
};
