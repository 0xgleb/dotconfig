import type { CompactionReason } from "./state.ts"

export type SafeCompactionMessagePhase = "preparing" | "resuming"

export interface CompactionVisual {
  readonly background: "selectedBg" | "toolPendingBg" | "toolErrorBg"
  readonly foreground: "accent" | "warning" | "customMessageLabel"
  readonly heading: "CHECKPOINT" | "RESTORED"
  readonly label: "manual request" | "context limit" | "context overflow"
}

export const compactionVisual = (
  reason: CompactionReason,
  phase: SafeCompactionMessagePhase,
): CompactionVisual => {
  const heading = phase === "preparing" ? "CHECKPOINT" : "RESTORED"
  switch (reason) {
    case "manual":
      return {
        background: "selectedBg",
        foreground: "accent",
        heading,
        label: "manual request",
      }
    case "threshold":
      return {
        background: "toolPendingBg",
        foreground: "warning",
        heading,
        label: "context limit",
      }
    case "overflow":
      return {
        background: "toolErrorBg",
        foreground: "customMessageLabel",
        heading,
        label: "context overflow",
      }
  }
}
