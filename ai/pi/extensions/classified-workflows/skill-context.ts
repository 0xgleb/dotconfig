import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

const MAX_SKILL_PROCEDURES = 4;
const MAX_PROCEDURE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 64_000;
const MAX_BRANCH_ENTRIES = 240;

interface SkillReadCall {
  id: string;
  path: string;
}

const isRecord: (value: unknown) => value is Record<string, unknown> = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textContent: (content: unknown) => string | undefined = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
  return text || undefined;
};

const isWithin: (path: string, root: string) => boolean = (path, root) =>
  path === root || path.startsWith(`${root}${sep}`);

const trustedSkillPath: (path: string, home: string, cwd: string) => string | undefined = (path, home, cwd) => {
  if (!isAbsolute(path) || basename(path) !== "SKILL.md") return undefined;
  const normalized = normalize(path);
  const roots = [
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".config", "ai", "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".pi", "skills"),
  ].map(normalize);
  return roots.some((root) => isWithin(normalized, root)) ? normalized : undefined;
};

const skillReadCalls: (message: Record<string, unknown>, home: string, cwd: string) => SkillReadCall[] = (
  message,
  home,
  cwd,
) => {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "toolCall" || part.name !== "read") return [];
    const args = isRecord(part.arguments) ? part.arguments : undefined;
    const path = args && typeof args.path === "string" ? trustedSkillPath(args.path, home, cwd) : undefined;
    return typeof part.id === "string" && path ? [{ id: part.id, path }] : [];
  });
};

export const activeSkillProcedures: (
  branch: unknown[],
  options?: { home?: string; cwd?: string; readSkillFile?: (path: string) => string },
) => string[] = (branch, options = {}) => {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const readSkillFile = options.readSkillFile ?? ((path: string) => readFileSync(path, "utf8"));
  const calls = new Map<string, string>();
  const procedures: string[] = [];
  let totalChars = 0;

  for (const entry of branch.slice(-MAX_BRANCH_ENTRIES)) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    for (const call of skillReadCalls(message, home, cwd)) calls.set(call.id, call.path);
    if (message.role !== "toolResult" || message.toolName !== "read" || typeof message.toolCallId !== "string") continue;
    const path = calls.get(message.toolCallId);
    if (!path) continue;
    if (!textContent(message.content)) continue;
    let content: string;
    try {
      content = readSkillFile(path);
    } catch {
      continue;
    }
    if (!content) continue;
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) break;
    const body = content.slice(0, Math.min(MAX_PROCEDURE_CHARS, remaining));
    const name = basename(dirname(path));
    procedures.push(`Active skill ${name} (${path}):\n${body}`);
    totalChars += body.length;
  }

  return procedures.slice(-MAX_SKILL_PROCEDURES);
};
