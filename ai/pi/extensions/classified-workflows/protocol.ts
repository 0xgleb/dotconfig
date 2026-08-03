export interface PiProcessSummary {
  output: string;
  usageTokens: number;
  stopReason?: string;
  errorMessage?: string;
}

export const boundedDiagnosticTail: (current: string, chunk: string, maxCharacters: number) => string = (
  current,
  chunk,
  maxCharacters,
) => {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("Diagnostic limit must be a positive integer.");
  }
  return `${current}${chunk}`.slice(-maxCharacters);
};

export const sanitizeProcessDiagnostic: (input: string) => string = (input) =>
  input
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:api[_-]?key|token|password|secret)"\s*:\s*)("(?:[^"\\]|\\.)*"|null)/gi, '$1"[REDACTED]"')
    .replace(/\b(api[_-]?key|token|password|secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .trim();

export const unknownErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === "string"
      ? error.message
      : fallback;

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export const usageTokensFromAssistantMessage = (message: unknown): number => {
  if (!isRecord(message) || message.role !== "assistant") return 0;
  const usage = isRecord(message.usage) ? message.usage : {};
  const totalTokens = nonNegativeNumber(usage.totalTokens);
  return totalTokens > 0 ? totalTokens : nonNegativeNumber(usage.input) + nonNegativeNumber(usage.output);
};

export const usageTokensFromPiJsonLine = (line: string): number => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 0;
  }
  if (!isRecord(parsed) || parsed.type !== "message_end") return 0;
  return usageTokensFromAssistantMessage(parsed.message);
};

const progressToolName = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : undefined;

export const piProcessProgressFromJsonLine = (
  line: string,
): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.type === "turn_start") return "model responding";
  if (
    parsed.type === "tool_execution_start" ||
    parsed.type === "tool_execution_update" ||
    parsed.type === "tool_execution_end"
  ) {
    const toolName = progressToolName(parsed.toolName);
    if (!toolName) return undefined;
    if (parsed.type === "tool_execution_start")
      return `tool ${toolName} started`;
    if (parsed.type === "tool_execution_update")
      return `tool ${toolName} streaming`;
    return `tool ${toolName} ${parsed.isError === true ? "failed" : "completed"}`;
  }
  if (
    parsed.type === "message_update" &&
    isRecord(parsed.assistantMessageEvent)
  ) {
    if (parsed.assistantMessageEvent.type === "thinking_delta")
      return "model reasoning";
    if (parsed.assistantMessageEvent.type === "text_delta")
      return "model drafting result";
  }
  return undefined;
};

export function summarizePiJsonLines(lines: string[]): PiProcessSummary {
  let output = "";
  let usageTokens = 0;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "message_end" || !isRecord(parsed.message)) continue;
    const message = parsed.message;
    if (message.role !== "assistant") continue;

    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
    if (text) output = text;
    const usage = isRecord(message.usage) ? message.usage : {};
    const totalTokens = nonNegativeNumber(usage.totalTokens);
    usageTokens +=
      totalTokens > 0 ? totalTokens : nonNegativeNumber(usage.input) + nonNegativeNumber(usage.output);
    if (typeof message.stopReason === "string") stopReason = message.stopReason;
    if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
  }

  return { output, usageTokens, stopReason, errorMessage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
