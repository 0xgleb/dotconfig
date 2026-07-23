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
