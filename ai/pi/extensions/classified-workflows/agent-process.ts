import type { AgentRequest } from "./core.ts";

export function buildAgentArguments(request: AgentRequest, extensionPath: string): string[] {
  const requestedTools = request.tools ?? ["read", "grep", "find", "ls"];
  const tools = requestedTools.filter((tool) => AGENT_TOOLS.has(tool));
  if (tools.length !== requestedTools.length || tools.length === 0) throw new Error("Agent requested an unsupported tool");
  if (extensionPath.trim() === "") throw new Error("Agent requires the classified workflow extension path");

  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--extension",
    extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    tools.join(","),
  ];
  if (request.model) args.push("--model", request.model);
  if (request.thinking) args.push("--thinking", request.thinking);
  args.push(request.task);
  return args;
}

const AGENT_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
