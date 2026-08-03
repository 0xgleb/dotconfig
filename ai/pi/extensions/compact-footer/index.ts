import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import { alignFooterLine, formatFooter } from "./presentation.ts";
import { aggregateUsage } from "./usage.ts";

function compactPath(cwd: string): string {
  const home = resolve(homedir());
  const absolute = resolve(cwd);
  const fromHome = relative(home, absolute);
  const insideHome =
    fromHome === "" ||
    (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
  return insideHome ? (fromHome === "" ? "~" : `~${sep}${fromHome}`) : cwd;
}

function cumulativeUsage(ctx: ExtensionContext): {
  inputTokens: number;
  outputTokens: number;
  cacheHitRate?: number;
} {
  return aggregateUsage(
    ctx.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .map((entry) => (entry.message as AssistantMessage).usage),
  );
}

export default function compactFooter(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "compact-footer", "2026.08.01.1");
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const usage = cumulativeUsage(ctx);
          const context = ctx.getContextUsage();
          const statuses = [...footerData.getExtensionStatuses().entries()]
            .filter(([key]) => key !== "auto-classifier")
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => value);
          const footer = formatFooter({
            cwd: compactPath(ctx.sessionManager.getCwd()),
            branch: footerData.getGitBranch() ?? undefined,
            modelId: ctx.model?.id ?? "no-model",
            thinkingLevel: ctx.model?.reasoning ? pi.getThinkingLevel() : undefined,
            contextPercent: context?.percent ?? undefined,
            contextWindow: context?.contextWindow ?? ctx.model?.contextWindow ?? 0,
            cacheHitRate: usage.cacheHitRate,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            statuses,
          });
          return [theme.fg("dim", alignFooterLine(footer, width))];
        },
      };
    });
  });
}
