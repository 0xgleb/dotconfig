import type { AssistantMessage } from "@earendil-works/pi-ai"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { alignFooterLine, formatFooter } from "./presentation.ts"
import {
  aggregateUsage,
  resolveContextPercent,
  type TokenUsage,
} from "./usage.ts"

function compactPath(cwd: string): string {
  const home = resolve(homedir())
  const absolute = resolve(cwd)
  const fromHome = relative(home, absolute)
  const insideHome =
    fromHome === "" ||
    (fromHome !== ".." &&
      !fromHome.startsWith(`..${sep}`) &&
      !isAbsolute(fromHome))
  return insideHome ? (fromHome === "" ? "~" : `~${sep}${fromHome}`) : cwd
}

function assistantUsages(ctx: ExtensionContext): TokenUsage[] {
  return ctx.sessionManager
    .getEntries()
    .filter(
      entry => entry.type === "message" && entry.message.role === "assistant",
    )
    .map(entry => (entry.message as AssistantMessage).usage)
}

interface UsageSnapshot {
  readonly contextPercent: number | undefined
  readonly contextWindow: number
  readonly cacheHitRate: number | undefined
  readonly inputTokens: number
  readonly outputTokens: number
}

const captureUsageSnapshot = (ctx: ExtensionContext): UsageSnapshot => {
  const usages = assistantUsages(ctx)
  const usage = aggregateUsage(usages)
  const context = ctx.getContextUsage()
  const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0
  return {
    contextPercent: resolveContextPercent(
      context?.percent,
      contextWindow,
      usages,
    ),
    contextWindow,
    cacheHitRate: usage.cacheHitRate,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  }
}

export default function compactFooter(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "compact-footer", "2026.08.23.1")
  let refreshCurrentSnapshot: (() => void) | undefined

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      let usageSnapshot = captureUsageSnapshot(ctx)
      const refreshUsageSnapshot = (): void => {
        usageSnapshot = captureUsageSnapshot(ctx)
        tui.requestRender()
      }
      refreshCurrentSnapshot = refreshUsageSnapshot
      const unsubscribe = footerData.onBranchChange(refreshUsageSnapshot)
      return {
        dispose: () => {
          unsubscribe()
          if (refreshCurrentSnapshot === refreshUsageSnapshot)
            refreshCurrentSnapshot = undefined
        },
        invalidate() {},
        render(width: number): string[] {
          const statuses = [...footerData.getExtensionStatuses().entries()]
            .filter(([key]) => key !== "auto-classifier")
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => value)
          const footer = formatFooter({
            cwd: compactPath(ctx.sessionManager.getCwd()),
            branch: footerData.getGitBranch() ?? undefined,
            modelId: ctx.model?.id ?? "no-model",
            thinkingLevel: ctx.model?.reasoning
              ? pi.getThinkingLevel()
              : undefined,
            contextPercent: usageSnapshot.contextPercent,
            contextWindow: usageSnapshot.contextWindow,
            cacheHitRate: usageSnapshot.cacheHitRate,
            inputTokens: usageSnapshot.inputTokens,
            outputTokens: usageSnapshot.outputTokens,
            statuses,
          })
          return [theme.fg("dim", alignFooterLine(footer, width))]
        },
      }
    })
  })

  pi.on("model_select", () => refreshCurrentSnapshot?.())
  pi.on("session_shutdown", () => {
    refreshCurrentSnapshot = undefined
  })
}
