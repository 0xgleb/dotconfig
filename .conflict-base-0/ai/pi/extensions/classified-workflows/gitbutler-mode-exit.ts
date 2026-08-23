interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

const REQUIRED_TEARDOWN = "but teardown --format agent";
const MODE_EXIT_DIAGNOSTIC = /GitButler mode exit required:\s*please run but teardown to preserve your work\./i;
const RELEVANT_DIAGNOSTIC_COMMAND = /^but (?:status -f --format agent|branch list --format agent)$/;
const NECESSITY_ONLY_BLOCK = /\b(?:not necessary|initialized GitButler workflow|use (?:the )?(?:initialized )?GitButler workflow)\b/i;
const INDEPENDENT_BLOCK =
  /\b(?:unauthori[sz]ed|unrelated|out of scope|secret|credential|protected|discard|destructive|irreversible|publish|deploy|external communication)\b/i;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const commandFromInput = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.command === "string" ? value.command.trim().replace(/\s+/g, " ") : undefined;

const resultText = (message: Readonly<Record<string, unknown>>): string => {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("\n");
};

/**
 * Correct only the fail-closed deadlock where current GitButler diagnostics
 * require its exact work-preserving mode-exit command but the semantic
 * classifier insists that the already-initialized workflow should be used.
 */
export const requiredGitButlerModeExitDisprovesBlock = (input: {
  readonly reason: string;
  readonly command: unknown;
  readonly branch: readonly unknown[];
}): boolean => {
  if (
    commandFromInput({ command: input.command }) !== REQUIRED_TEARDOWN ||
    !NECESSITY_ONLY_BLOCK.test(input.reason) ||
    INDEPENDENT_BLOCK.test(input.reason)
  ) return false;

  const calls = new Map<string, ToolCall>();
  for (const entry of input.branch) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        isRecord(part) &&
        part.type === "toolCall" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) calls.set(part.id, { name: part.name, input: part.arguments });
    }
  }

  for (let index = input.branch.length - 1; index >= 0; index -= 1) {
    const entry = input.branch[index];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const call = calls.get(message.toolCallId);
    if (call?.name !== "bash") continue;
    const diagnosticCommand = commandFromInput(call.input);
    if (!diagnosticCommand?.startsWith("but ")) continue;
    return RELEVANT_DIAGNOSTIC_COMMAND.test(diagnosticCommand) && MODE_EXIT_DIAGNOSTIC.test(resultText(message));
  }

  return false;
};
