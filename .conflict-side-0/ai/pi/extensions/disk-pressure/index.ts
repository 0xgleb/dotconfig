import { spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { availableMemoryBytes } from "../shared/memory-capacity.ts";
import {
  RESOURCE_PREFLIGHT_REQUEST_EVENT,
  type ResourcePreflightRequest,
  type ResourcePreflightSnapshot,
} from "../shared/resource-preflight.ts";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import { claimResourceIncident, clearResourceIncident } from "./incident.ts";

import {
  CRITICAL_FREE_BYTES,
  CRITICAL_FREE_MEMORY_BYTES,
  WARNING_FREE_BYTES,
  WARNING_FREE_MEMORY_BYTES,
  aggregateProcessRss,
  cleanupNewResultSymlinks,
  cleanupStalePiTempLogs,
  formatFreeBytes,
  isExpensiveCommand,
  resourcePressureDecision,
  resultSymlinkNames,
} from "./core.ts";

const STATUS_KEY = "disk-pressure";
const INCIDENT_TTL_MS = 10 * 60_000;
const INCIDENT_PATH = join(homedir(), ".local", "state", "pi", "resource-pressure", "incident.json");

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

const processAggregateText = (): string => {
  const result = spawnSync("ps", ["-axo", "rss=,comm="], {
    encoding: "utf8",
    maxBuffer: 512 * 1_024,
    timeout: 5_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return "Process aggregate unavailable.";
  const aggregates = aggregateProcessRss(result.stdout);
  return aggregates.length === 0
    ? "No process aggregate rows were available."
    : aggregates.map(({ command, count, rssMiB }) => `- ${rssMiB} MiB · ${count}× ${command}`).join("\n");
};

export default (pi: ExtensionAPI) => {
  registerRuntimeVersion(pi, "resource-pressure", "2026.07.23.8");
  const pendingBuilds = new Map<string, PendingBuild>();

  const resourcePressureSnapshot = (cwd: string, command: string): ResourcePreflightSnapshot | undefined => {
    if (!isExpensiveCommand(command)) return undefined;
    const diskAvailable = freeBytes(cwd);
    const memoryAvailable = availableMemoryBytes();
    const decision = resourcePressureDecision(command, diskAvailable, memoryAvailable);
    return {
      verdict: decision.verdict,
      ...(decision.verdict === "block" ? { reason: decision.reason } : {}),
      diskAvailableBytes: String(diskAvailable),
      diskReserveBytes: String(CRITICAL_FREE_BYTES),
      memoryAvailableBytes: String(memoryAvailable),
      memoryReserveBytes: String(CRITICAL_FREE_MEMORY_BYTES),
      checkedAt: Date.now(),
    };
  };

  pi.events.on(RESOURCE_PREFLIGHT_REQUEST_EVENT, (request: ResourcePreflightRequest) => {
    try {
      request.report(resourcePressureSnapshot(request.cwd, request.command));
    } catch {
      request.report(undefined);
    }
  });

  const reconcileMemoryIncident = (ctx: ExtensionContext, memoryAvailable: bigint): void => {
    if (memoryAvailable >= WARNING_FREE_MEMORY_BYTES) {
      Effect.runSync(Effect.either(clearResourceIncident(INCIDENT_PATH)));
      return;
    }
    if (memoryAvailable >= CRITICAL_FREE_MEMORY_BYTES) return;
    const claimed = Effect.runSync(
      Effect.either(
        claimResourceIncident(
          INCIDENT_PATH,
          ctx.sessionManager.getSessionId(),
          Date.now(),
          INCIDENT_TTL_MS,
        ),
      ),
    );
    if (Either.isLeft(claimed)) {
      ctx.ui.notify("Memory pressure requires action, but Pi could not claim the remediation incident. Close or restart a high-memory application before expensive work.", "warning");
      return;
    }
    if (!claimed.right) return;
    const available = formatFreeBytes(memoryAvailable);
    ctx.ui.notify(`Memory pressure action assigned to this session: ${available} available. Remediation will start now.`, "warning");
    pi.sendMessage(
      {
        customType: "resource-pressure.incident",
        content: [
          `Critical memory-pressure incident: ${available} available, below the ${formatFreeBytes(CRITICAL_FREE_MEMORY_BYTES)} crash reserve.`,
          "This is an actionable incident, not a passive warning. Stop expensive work and do not poll resource commands repeatedly.",
          "Use the bounded harness snapshot below. Cancel or clean only evidenced agent-owned orphaned workflow processes/artifacts.",
          "Do not close user applications or kill unrelated processes without a focused user confirmation. If a user application dominates, ask one direct question naming it and the observed aggregate.",
          "Report the action taken and continue independently safe work.",
          "",
          "Bounded RSS aggregate (command names only; no arguments):",
          processAggregateText(),
        ].join("\n"),
        display: true,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      const removed = cleanupStalePiTempLogs(tmpdir());
      const available = freeBytes(ctx.cwd);
      const memoryAvailable = availableMemoryBytes();
      updateStatus(ctx, available, memoryAvailable);
      reconcileMemoryIncident(ctx, memoryAvailable);
      if (removed.length > 0) ctx.ui.notify(`Cleaned ${removed.length} stale Pi temporary log${removed.length === 1 ? "" : "s"}.`);
      if (available < CRITICAL_FREE_BYTES) {
        ctx.ui.notify(
          `Disk pressure critical: ${formatFreeBytes(available)} free. Expensive builds are blocked until space is recovered.`,
          "warning",
        );
      }
    } catch (error) {
      ctx.ui.notify(`Resource-pressure check failed safely: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
    }
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event) || !isExpensiveCommand(event.input.command)) return;
    try {
      const available = freeBytes(ctx.cwd);
      const memoryAvailable = availableMemoryBytes();
      updateStatus(ctx, available, memoryAvailable);
      reconcileMemoryIncident(ctx, memoryAvailable);
      const decision = resourcePressureDecision(event.input.command, available, memoryAvailable);
      if (decision.verdict === "block") {
        return decision.reason === "disk pressure"
          ? {
              block: true,
              reason: `Disk pressure guard: only ${formatFreeBytes(available)} free; reserve ${formatFreeBytes(CRITICAL_FREE_BYTES)} before expensive builds. Clean agent-owned artifacts or explicitly authorize broader cache cleanup.`,
            }
          : {
              block: true,
              reason: `Memory pressure incident: only ${formatFreeBytes(memoryAvailable)} available; reserve ${formatFreeBytes(CRITICAL_FREE_MEMORY_BYTES)} before expensive builds. One Pi session has been assigned a bounded remediation turn. Follow that call to action; do not poll repeatedly or retry this build until recovery is reported.`,
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
      const memoryAvailable = availableMemoryBytes();
      updateStatus(ctx, available, memoryAvailable);
      reconcileMemoryIncident(ctx, memoryAvailable);
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
