import { globSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isSafeHandoffName, managedPiWatchPaths } from "./core.ts";

const DEBOUNCE_MS = 1_200;
const IDLE_RETRY_MS = 1_000;
const STATUS_KEY = "auto-reload";

interface ReloadableContext extends ExtensionContext {
  reload(): Promise<void>;
}

const isReloadableContext: (ctx: ExtensionContext) => ctx is ReloadableContext = (ctx) =>
  "reload" in ctx && typeof ctx.reload === "function";

const autoReload: (pi: ExtensionAPI) => void = (pi) => {
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const closeWatchers = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = false;
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const reloadWhenIdle = async (ctx: ReloadableContext) => {
    if (!pending) return;
    if (!ctx.isIdle()) {
      timer = setTimeout(() => void reloadWhenIdle(ctx), IDLE_RETRY_MS);
      return;
    }
    pending = false;
    timer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    await ctx.reload();
  };

  const scheduleReload = (ctx: ReloadableContext, changedPath: string | null) => {
    if (changedPath?.includes("node_modules") || changedPath?.includes("brave-operator-profile")) return;
    pending = true;
    ctx.ui.setStatus(STATUS_KEY, "reload:pending");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reloadWhenIdle(ctx), DEBOUNCE_MS);
  };

  pi.on("session_start", (event, ctx) => {
    closeWatchers();
    if (event.reason === "reload") {
      pi.sendMessage(
        {
          customType: "auto-reload.completed",
          content: "Pi resources auto-reloaded after managed configuration changed. Resume all assigned work now; do not stop while a goal or pending todo remains.",
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
    if (!isReloadableContext(ctx)) {
      ctx.ui.notify("Automatic Pi reload requires the managed reload-context host patch; restart after applying the Nix generation.", "warning");
      return;
    }
    const configRoot = join(homedir(), ".config");
    const aiRoot = join(configRoot, "ai");
    for (const path of managedPiWatchPaths(aiRoot)) {
      try {
        const recursive = statSync(path).isDirectory();
        watchers.push(watch(path, { recursive }, (_eventType, filename) => scheduleReload(ctx, filename)));
      } catch (error) {
        ctx.ui.notify(`Could not watch ${path}: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
      }
    }

    ctx.ui.setStatus(STATUS_KEY, "reload:auto");

    if (ctx.cwd === configRoot) {
      const handoffRoot = join(configRoot, ".tmp");
      try {
        const seen = new Set(globSync("*.md", { cwd: handoffRoot }));
        watchers.push(
          watch(handoffRoot, (_eventType, filename) => {
            if (!filename || !isSafeHandoffName(filename) || seen.has(filename)) return;
            seen.add(filename);
            pi.sendMessage(
              {
                customType: "auto-reload.pi-handoff",
                content: `New Pi bug handoff: ${join(handoffRoot, filename)}. Read it, add every request to the todo list, and continue the work.`,
                display: true,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          }),
        );
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
