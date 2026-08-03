import { isAbsolute, resolve } from "node:path";

interface EditReplacement {
  readonly oldText: string;
}

interface EditInput {
  readonly path: string;
  readonly edits: readonly EditReplacement[];
}

interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const editInput = (value: unknown): EditInput | null => {
  if (!isRecord(value) || typeof value.path !== "string" || !Array.isArray(value.edits)) return null;
  const edits = value.edits.flatMap((entry) =>
    isRecord(entry) && typeof entry.oldText === "string" && entry.oldText.length > 0
      ? [{ oldText: entry.oldText }]
      : [],
  );
  return edits.length === value.edits.length && edits.length > 0
    ? { path: value.path, edits }
    : null;
};

const toolPath = (cwd: string, value: unknown): string | null => {
  if (!isRecord(value) || typeof value.path !== "string") return null;
  return resolve(isAbsolute(value.path) ? value.path : resolve(cwd, value.path));
};

const resultText = (message: Readonly<Record<string, unknown>>): string => {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("\n");
};

const duplicateOnlyReason = (reason: string): boolean => {
  const duplicate =
    /\b(?:already (?:present|applied|implemented|made|done|exists|succeeded|completed|ran|executed|in (?:place|the file|source))|duplicate(?:d| operation)?|reapp(?:ly|lying)|no-op)\b/i;
  const independentBlock =
    /\b(?:unauthori[sz]ed|not authorized|unrelated|out of scope|secret|credential|protected|destructive|irreversible|permission|publish|deploy|external communication|user approval|not requested)\b/i;
  return duplicate.test(reason) && !independentBlock.test(reason);
};

/**
 * Correct only a classifier's duplicate-only factual mistake.
 *
 * A successful current read containing every exact edit anchor proves the
 * replacement is not already applied. Any later successful mutation of that
 * path makes the read stale and keeps the block intact. Exact-replacement Edit
 * remains fail-closed if the file changes outside the recorded session.
 */
export const currentMissingBuildOutputDisprovesDuplicateBlock = (input: {
  readonly reason: string;
  readonly bash: unknown;
  readonly branch: readonly unknown[];
}): boolean => {
  if (!duplicateOnlyReason(input.reason) || !isRecord(input.bash)) return false;
  if (typeof input.bash.command !== "string") return false;
  const command = input.bash.command.trim();
  if (!/^nix\s+build(?:\s|$)/.test(command) || /[;&|`\n]/.test(command))
    return false;

  const calls = new Map<string, ToolCall>();
  let successfulBuildIndex = -1;
  let missingOutputIndex = -1;

  input.branch.forEach((entry, index) => {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message))
      return;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          isRecord(part) &&
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        )
          calls.set(part.id, { name: part.name, input: part.arguments });
      }
      return;
    }
    if (
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string"
    )
      return;
    const call = calls.get(message.toolCallId);
    if (!call || call.name !== "bash" || !isRecord(call.input)) return;
    if (typeof call.input.command !== "string") return;
    const priorCommand = call.input.command.trim();
    if (message.isError === false && priorCommand === command) {
      successfulBuildIndex = index;
      return;
    }
    if (
      message.isError === true &&
      /^nix\s+path-info(?:\s|$)/.test(priorCommand) &&
      /(?:is not valid|not built|does not exist|does not have a valid path)/i.test(
        resultText(message),
      )
    )
      missingOutputIndex = index;
  });

  return (
    successfulBuildIndex >= 0 && missingOutputIndex > successfulBuildIndex
  );
};

export const currentReadDisprovesDuplicateBlock = (input: {
  readonly reason: string;
  readonly edit: unknown;
  readonly branch: readonly unknown[];
  readonly cwd: string;
}): boolean => {
  if (!duplicateOnlyReason(input.reason)) return false;
  const proposed = editInput(input.edit);
  if (!proposed) return false;
  const target = toolPath(input.cwd, proposed);
  if (!target) return false;

  const calls = new Map<string, ToolCall>();
  let matchingReadIndex = -1;
  let laterMutationIndex = -1;

  input.branch.forEach((entry, index) => {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          isRecord(part) &&
          part.type === "toolCall" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        ) {
          calls.set(part.id, { name: part.name, input: part.arguments });
        }
      }
      return;
    }
    if (
      message.role !== "toolResult" ||
      message.isError !== false ||
      typeof message.toolCallId !== "string"
    ) return;
    const call = calls.get(message.toolCallId);
    if (!call || toolPath(input.cwd, call.input) !== target) return;
    if (call.name === "read") {
      const text = resultText(message);
      if (proposed.edits.every(({ oldText }) => text.includes(oldText))) matchingReadIndex = index;
      return;
    }
    if (call.name === "edit" || call.name === "write") laterMutationIndex = index;
  });

  return matchingReadIndex >= 0 && laterMutationIndex < matchingReadIndex;
};
