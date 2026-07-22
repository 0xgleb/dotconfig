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
    .replace(/\b(api[_-]?key|token|password|secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .trim();

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

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
