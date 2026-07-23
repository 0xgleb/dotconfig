import { spawnSync } from "node:child_process";
import { globSync, lstatSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  HANDOFF_GLOBS,
  isSafeHandoffName,
  managedPiChangeLabel,
  managedPiWatchPaths,
  parseManagedReloadSummary,
  parseSeenHandoffNames,
  shouldDispatchReloadFollowUp,
  unseenHandoffNames,
} from "./core.ts";
import { isContinuationPaused } from "../shared/continuation-pause.ts";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";

const DEBOUNCE_MS = 30_000;
const HANDOFF_POLL_MS = 60 * 60 * 1_000;
const HANDOFF_STATE_ENTRY = "auto-reload.seen-pi-handoffs";
const RELOAD_SUMMARY_ENTRY = "auto-reload.managed-change-summary";
const IDLE_RETRY_MS = 1_000;
const COMMIT_RETRY_MS = 2_000;
const GENERATION_POLL_MS = 5_000;
const STATUS_KEY = "auto-reload";

interface ReloadableContext extends ExtensionContext {
  reload(): Promise<void>;
}

const isReloadableContext: (ctx: ExtensionContext) => ctx is ReloadableContext = (ctx) =>
  "reload" in ctx && typeof ctx.reload === "function";

export const managedSourcesAreCommitted = (configRoot: string): boolean => {
  const isClean = (mode: readonly string[]) =>
    spawnSync("git", ["-C", configRoot, "diff", ...mode, "--quiet", "--", "ai"], {
      stdio: "ignore",
      timeout: 5_000,
    }).status === 0;
  return isClean([]) && isClean(["--cached"]);
};

export const managedGeneration = (roots: readonly string[]): string => {
  const records: string[] = [];
  const visit = (candidate: string) => {
    try {
      const stat = lstatSync(candidate);
      records.push(`${candidate}:${stat.mtimeMs}:${stat.size}:${stat.mode}`);
      if (!stat.isDirectory()) return;
      for (const name of readdirSync(candidate)) {
        if (name === "node_modules" || name === "brave-operator-profile") continue;
        visit(join(candidate, name));
      }
    } catch {
      records.push(`${candidate}:missing`);
    }
  };
  roots.forEach(visit);
  return records.sort().join("\n");
};

const autoReload: (pi: ExtensionAPI) => void = (pi) => {
  registerRuntimeVersion(pi, "auto-reload", "2026.07.23.2");
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handoffTimer: ReturnType<typeof setInterval> | undefined;
  let generationTimer: ReturnType<typeof setInterval> | undefined;
  let pending = false;
  const changedLabels = new Set<string>();

  const closeWatchers = () => {
    if (timer) clearTimeout(timer);
    if (handoffTimer) clearInterval(handoffTimer);
    if (generationTimer) clearInterval(generationTimer);
    timer = undefined;
    handoffTimer = undefined;
    generationTimer = undefined;
    pending = false;
    changedLabels.clear();
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const reloadWhenIdle = async (ctx: ReloadableContext) => {
    if (!pending) return;
    if (!managedSourcesAreCommitted(join(homedir(), ".config"))) {
      ctx.ui.setStatus(STATUS_KEY, "reload:awaiting-commit");
      timer = setTimeout(() => void reloadWhenIdle(ctx), COMMIT_RETRY_MS);
      return;
    }
    if (!ctx.isIdle()) {
      timer = setTimeout(() => void reloadWhenIdle(ctx), IDLE_RETRY_MS);
      return;
    }
    pending = false;
    timer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (changedLabels.size > 0) {
      pi.appendEntry(RELOAD_SUMMARY_ENTRY, {
        labels: [...changedLabels].sort(),
        createdAt: Date.now(),
        announced: false,
      });
      changedLabels.clear();
    }
    await ctx.reload();
  };

  const scheduleReload = (ctx: ReloadableContext, changedPath: string | null, aiRoot: string) => {
    if (changedPath?.includes("node_modules") || changedPath?.includes("brave-operator-profile")) return;
    if (changedPath) changedLabels.add(managedPiChangeLabel(changedPath, aiRoot));
    pending = true;
    ctx.ui.setStatus(STATUS_KEY, "reload:pending");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reloadWhenIdle(ctx), DEBOUNCE_MS);
  };

  pi.on("session_start", (event, ctx) => {
    closeWatchers();
    const branch = ctx.sessionManager.getBranch();
    const summaryEntry = branch
      .filter((entry) => entry.type === "custom" && entry.customType === RELOAD_SUMMARY_ENTRY)
      .at(-1);
    const summary = summaryEntry?.type === "custom" ? parseManagedReloadSummary(summaryEntry.data) : undefined;
    if (event.reason === "reload") {
      const changeText = summary && !summary.announced && summary.labels.length > 0
        ? ` Updated: ${summary.labels.join(", ")}.`
        : "";
      const message = {
        customType: "auto-reload.completed",
        content: `Pi resources auto-reloaded after managed configuration changed.${changeText} Resume all assigned work now; do not stop while a goal or pending todo remains.`,
        display: true,
      };
      if (shouldDispatchReloadFollowUp(event.reason, branch)) {
        pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      } else {
        pi.sendMessage(message);
      }
      if (summary && !summary.announced) {
        pi.appendEntry(RELOAD_SUMMARY_ENTRY, { ...summary, announced: true });
      }
    }
    if (!isReloadableContext(ctx)) {
      ctx.ui.notify("Automatic Pi reload requires the managed reload-context host patch; restart after applying the Nix generation.", "warning");
      return;
    }
    const configRoot = join(homedir(), ".config");
    const aiRoot = join(configRoot, "ai");
    const watchPaths = managedPiWatchPaths(aiRoot);
    let generation = managedGeneration(watchPaths);
    for (const path of watchPaths) {
      try {
        const recursive = statSync(path).isDirectory();
        watchers.push(
          watch(path, { recursive }, (_eventType, filename) =>
            scheduleReload(ctx, recursive && filename ? join(path, String(filename)) : path, aiRoot),
          ),
        );
      } catch (error) {
        ctx.ui.notify(`Could not watch ${path}: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
      }
    }

    generationTimer = setInterval(() => {
      const nextGeneration = managedGeneration(watchPaths);
      if (nextGeneration === generation) return;
      generation = nextGeneration;
      scheduleReload(ctx, aiRoot, aiRoot);
    }, GENERATION_POLL_MS);
    generationTimer.unref?.();

    ctx.ui.setStatus(STATUS_KEY, "reload:auto");

    if (ctx.cwd === configRoot) {
      ctx.ui.setStatus(STATUS_KEY, "reload:auto · requests:hourly");
      const handoffRoot = join(configRoot, ".tmp");
      try {
        const storedEntry = ctx.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === HANDOFF_STATE_ENTRY)
          .at(-1);
        const persisted = storedEntry?.type === "custom" ? parseSeenHandoffNames(storedEntry.data) : [];
        const current = globSync(HANDOFF_GLOBS, { cwd: handoffRoot }).filter(isSafeHandoffName);
        const seen = new Set(storedEntry ? persisted : current);
        if (!storedEntry) pi.appendEntry(HANDOFF_STATE_ENTRY, { names: [...seen].sort() });

        const reconcileHandoffs = () => {
          if (isContinuationPaused(ctx.sessionManager.getBranch())) return;
          const unseen = unseenHandoffNames(globSync(HANDOFF_GLOBS, { cwd: handoffRoot }), seen);
          if (unseen.length === 0) return;
          for (const name of unseen) seen.add(name);
          pi.appendEntry(HANDOFF_STATE_ENTRY, { names: [...seen].sort() });
          pi.sendMessage(
            {
              customType: "auto-reload.pi-handoff",
              content: `New Pi bug handoff${unseen.length === 1 ? "" : "s"}:\n${unseen.map((name) => join(handoffRoot, name)).join("\n")}\nRead each file, add every request to the todo list, and continue the work.`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        };

        reconcileHandoffs();
        watchers.push(
          watch(handoffRoot, { recursive: true }, (_eventType, filename) => {
            if (!filename || !isSafeHandoffName(filename)) return;
            reconcileHandoffs();
          }),
        );
        handoffTimer = setInterval(reconcileHandoffs, HANDOFF_POLL_MS);
        handoffTimer.unref?.();
      } catch (error) {
        ctx.ui.notify(`Could not watch Pi handoffs: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    closeWatchers();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
};

export default autoReload;
