import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import {
  CRITICAL_FREE_BYTES,
  WARNING_FREE_BYTES,
  cleanupNewResultSymlinks,
  cleanupStalePiTempLogs,
  diskPressureDecision,
  formatFreeBytes,
  isExpensiveCommand,
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

const updateStatus: (ctx: ExtensionContext, available: bigint) => void = (ctx, available) => {
  const marker = available < CRITICAL_FREE_BYTES ? "!" : available < WARNING_FREE_BYTES ? "~" : "";
  ctx.ui.setStatus(STATUS_KEY, `disk:${formatFreeBytes(available)}${marker}`);
};

export default (pi: ExtensionAPI) => {
  const pendingBuilds = new Map<string, PendingBuild>();

  pi.on("session_start", (_event, ctx) => {
    try {
      const removed = cleanupStalePiTempLogs(tmpdir());
      const available = freeBytes(ctx.cwd);
      updateStatus(ctx, available);
      if (removed.length > 0) ctx.ui.notify(`Cleaned ${removed.length} stale Pi temporary log${removed.length === 1 ? "" : "s"}.`);
      if (available < CRITICAL_FREE_BYTES) {
        ctx.ui.notify(
          `Disk pressure critical: ${formatFreeBytes(available)} free. Expensive builds are blocked until space is recovered.`,
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
      updateStatus(ctx, available);
      const decision = diskPressureDecision(event.input.command, available);
      if (decision.verdict === "block") {
        return {
          block: true,
          reason: `Disk pressure guard: only ${formatFreeBytes(available)} free; reserve ${formatFreeBytes(CRITICAL_FREE_BYTES)} before expensive builds. Clean agent-owned artifacts or explicitly authorize broader cache cleanup.`,
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
      updateStatus(ctx, available);
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
