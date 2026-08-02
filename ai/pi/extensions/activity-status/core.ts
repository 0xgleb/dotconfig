import { join, resolve } from "node:path";

export const usageThrottleLabel = (
  cwd: string,
  home: string,
): string | undefined => {
  const current = resolve(cwd);
  return current === resolve(home, ".config") ||
    current === resolve(home, "code", "dataclique", "yielduck")
    ? "THROTTLED · 5m between model-heavy batches · human prompts bypass"
    : undefined;
};

export type ActivityPhase =
  | { readonly kind: "model"; readonly label: string }
  | { readonly kind: "reasoning"; readonly label: string }
  | { readonly kind: "response"; readonly label: string }
  | { readonly kind: "tool"; readonly label: string }
  | { readonly kind: "subagent"; readonly label: string }
  | { readonly kind: "classifier"; readonly label: string }
  | { readonly kind: "compacting"; readonly label: string };

const toolKind = (toolName: string): string => {
  if (["read", "write", "edit", "grep", "find", "ls", "artifact_provenance"].includes(toolName)) return "filesystem";
  if (toolName === "bash") return "process running";
  if (toolName === "browser") return "operator browser I/O";
  if (toolName === "workflow" || toolName === "agent") return "model generation";
  if (["session_search", "memory_search", "memory"].includes(toolName)) return "local index query";
  if (["agent_registry", "todo", "ask_user", "workflow_audit"].includes(toolName)) return "local state";
  return "external operation";
};

export const toolPhase = (toolName: string): ActivityPhase =>
  toolName === "workflow" || toolName === "agent"
    ? { kind: "subagent", label: `SUBAGENT · ${toolName} · ${toolKind(toolName)}` }
    : { kind: "tool", label: `TOOL · ${toolName} · ${toolKind(toolName)}` };

export interface ToolProgress {
  readonly toolName: string;
  readonly startedAt: number;
  readonly updateCount: number;
  readonly bufferedLineCount: number;
}

export const startToolProgress = (toolName: string, startedAt: number): ToolProgress => ({
  toolName,
  startedAt,
  updateCount: 0,
  bufferedLineCount: 0,
});

const bufferedLineCount = (partialResult: unknown): number => {
  if (
    typeof partialResult !== "object" ||
    partialResult === null ||
    !("content" in partialResult) ||
    !Array.isArray(partialResult.content)
  ) {
    return 0;
  }
  return partialResult.content.reduce((count, part) => {
    if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "text" || !("text" in part)) {
      return count;
    }
    if (typeof part.text !== "string") return count;
    return count + part.text.split(/\r?\n/u).filter((line) => line.length > 0).length;
  }, 0);
};

export const observeToolProgress = (progress: ToolProgress, partialResult: unknown): ToolProgress => ({
  ...progress,
  updateCount: progress.updateCount + 1,
  bufferedLineCount: Math.max(progress.bufferedLineCount, bufferedLineCount(partialResult)),
});

const countLabel = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`;

const elapsedSeconds = (startedAt: number, now: number): number => Math.max(0, Math.floor((now - startedAt) / 1_000));

export const runningToolProgressPhase = (tools: readonly ToolProgress[], now: number): ActivityPhase => {
  if (tools.length === 0) return { kind: "model", label: "MODEL · integrating tool results" };
  const oldest = Math.max(...tools.map((tool) => elapsedSeconds(tool.startedAt, now)));
  const updates = tools.reduce((total, tool) => total + tool.updateCount, 0);
  const lines = tools.reduce((total, tool) => total + tool.bufferedLineCount, 0);
  const progress = lines > 0 ? countLabel(lines, "buffered line") : "heartbeat";
  if (tools.length === 1) {
    const tool = tools[0] ?? startToolProgress("unknown", now);
    return {
      kind: tool.toolName === "workflow" || tool.toolName === "agent" ? "subagent" : "tool",
      label: `${toolPhase(tool.toolName).label} · ${oldest}s · ${countLabel(updates, "update")} · ${progress}`,
    };
  }
  const kinds = [...new Set(tools.map(({ toolName }) => toolKind(toolName)))].join(" + ");
  return {
    kind: "tool",
    label: `TOOLS · ${tools.length} running · ${kinds} · oldest ${oldest}s · ${countLabel(updates, "update")} · ${progress}`,
  };
};

export const assistantPhase = (message: unknown): ActivityPhase | undefined => {
  if (typeof message !== "object" || message === null || !("content" in message) || !Array.isArray(message.content)) {
    return undefined;
  }
  const content = [...message.content].reverse().find((part) => {
    if (typeof part !== "object" || part === null || !("type" in part)) return false;
    if (part.type === "thinking") return "thinking" in part && typeof part.thinking === "string" && part.thinking.length > 0;
    if (part.type === "text") return "text" in part && typeof part.text === "string" && part.text.length > 0;
    return part.type === "toolCall";
  });
  if (typeof content !== "object" || content === null || !("type" in content)) return undefined;
  if (content.type === "thinking") return { kind: "reasoning", label: "REASONING · model generation · no tools implied" };
  if (content.type === "text") return { kind: "response", label: "RESPONSE · model generation" };
  if (content.type === "toolCall" && "name" in content && typeof content.name === "string") {
    return { kind: "tool", label: `TOOL · preparing ${content.name} arguments` };
  }
  return undefined;
};

export const runningToolsPhase = (toolNames: readonly string[]): ActivityPhase => {
  if (toolNames.length === 1) return toolPhase(toolNames[0] ?? "unknown");
  const kinds = [...new Set(toolNames.map(toolKind))].join(" + ");
  return { kind: "tool", label: `TOOLS · ${toolNames.length} running · ${kinds}` };
};
