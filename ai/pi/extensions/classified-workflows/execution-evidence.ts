import { createHash } from "node:crypto";
import { sanitizeProcessDiagnostic } from "./protocol.ts";

const FIELD_PATTERN = /"(id|login|isResolved|databaseId|number|url)"\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+)/gi;

export const boundedExecutionEvidence = (text: string, maxCharacters = 4_000): string => {
  const sanitized = sanitizeProcessDiagnostic(text).replace(/\s+/g, " ").trim();
  if (sanitized.length <= maxCharacters) return sanitized;

  const fields: string[] = [];
  for (const match of sanitized.matchAll(FIELD_PATTERN)) {
    fields.push(`${match[1]}=${match[2]}`);
    if (fields.length >= 120) break;
  }
  const structured = fields.length > 0 ? ` [structured fields: ${fields.join(", ")}]` : "";
  if (structured) {
    const structuredTail = structured.slice(0, Math.max(0, maxCharacters - 64));
    const headLimit = Math.max(0, Math.min(192, maxCharacters - structuredTail.length - 24));
    return `${sanitized.slice(0, headLimit)} …[bounded]${structuredTail}`.slice(0, maxCharacters);
  }
  const half = Math.max(0, Math.floor((maxCharacters - 24) / 2));
  return `${sanitized.slice(0, half)} …[bounded] ${sanitized.slice(-half)}`.slice(0, maxCharacters);
};

const EVIDENCE_STOP_WORDS = new Set([
  "action",
  "bash",
  "command",
  "content",
  "false",
  "input",
  "result",
  "toolname",
  "true",
]);

const evidenceTerms = (value: unknown): ReadonlySet<string> => {
  const serialized = JSON.stringify(value)?.toLowerCase() ?? "";
  return new Set(
    (serialized.match(/[a-z0-9_./:#-]{4,}/g) ?? [])
      .map((term) => term.replace(/^[-./:#]+|[-./:#]+$/g, ""))
      .filter((term) => term.length >= 4 && !EVIDENCE_STOP_WORDS.has(term)),
  );
};

const focusedEvidenceTerms = (value: unknown): readonly string[] => {
  const serialized = JSON.stringify(value)?.toLowerCase() ?? "";
  return [...new Set(
    (serialized.match(/[a-z0-9_./:#-]{3,}/g) ?? [])
      .map((term) => term.replace(/^[-./:#]+|[-./:#]+$/g, ""))
      .filter((term) => term.length >= 3 && !EVIDENCE_STOP_WORDS.has(term)),
  )].sort((left, right) => right.length - left.length);
};

/** Preserve the parts of a large result that share exact anchors with the proposed action. */
export const boundedRelevantExecutionEvidence = (
  text: string,
  subject: unknown,
  maxCharacters = 4_000,
): string => {
  const sanitized = sanitizeProcessDiagnostic(text).replace(/\s+/g, " ").trim();
  if (sanitized.length <= maxCharacters) return sanitized;
  const lower = sanitized.toLowerCase();
  const windows: Array<{ start: number; end: number }> = [];
  for (const term of focusedEvidenceTerms(subject)) {
    let offset = 0;
    while (windows.length < 8) {
      const index = lower.indexOf(term, offset);
      if (index < 0) break;
      const start = Math.max(0, index - 180);
      const end = Math.min(sanitized.length, index + term.length + 220);
      if (!windows.some((window) => start <= window.end && end >= window.start)) windows.push({ start, end });
      offset = index + term.length;
    }
    if (windows.length >= 8) break;
  }
  if (windows.length === 0) return boundedExecutionEvidence(sanitized, maxCharacters);
  const focused = windows
    .sort((left, right) => left.start - right.start)
    .map(({ start, end }) => sanitized.slice(start, end))
    .join(" … ");
  return `…[subject-focused] ${focused}`.slice(0, maxCharacters);
};

const canonicalInput: (value: unknown) => unknown = (value) => {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalInput(entry)]),
  );
};

export const toolInputDigest: (toolName: string, input: unknown) => string = (toolName, input) =>
  createHash("sha256")
    .update(toolName)
    .update("\0")
    .update(JSON.stringify(canonicalInput(input)) ?? "undefined")
    .digest("hex");

export interface ToolResultExecutionEvidenceInput {
  readonly toolName: unknown;
  readonly text: string;
  readonly isError: unknown;
  readonly inputDigest?: string;
  readonly subject: unknown;
  readonly maxCharacters?: number;
}

/** Preserve execution status separately from untrusted result wording. */
export const toolResultExecutionEvidence: (input: ToolResultExecutionEvidenceInput) => string = ({
  toolName,
  text,
  isError,
  inputDigest,
  subject,
  maxCharacters = 2_400,
}) => {
  const name = sanitizeProcessDiagnostic(String(toolName ?? "tool")).replace(/\s+/g, " ").slice(0, 64) || "tool";
  const status = isError === true ? "error" : isError === false ? "success" : "unknown";
  const identity = inputDigest && /^[0-9a-f]{64}$/.test(inputDigest) ? ` inputDigest=${inputDigest}` : "";
  return `${name} result status=${status}${identity}: ${boundedRelevantExecutionEvidence(text, subject, maxCharacters)}`;
};

/** Keep a small recency window plus older evidence that shares concrete identifiers with the proposed boundary. */
export const selectRelevantExecutionEvidence = (
  candidates: readonly string[],
  subject: unknown,
  recentCount = 8,
  relevantCount = 8,
): readonly string[] => {
  const recentStart = Math.max(0, candidates.length - recentCount);
  const recent = candidates.slice(recentStart);
  const terms = evidenceTerms(subject);
  const older = candidates
    .slice(0, recentStart)
    .map((candidate, index) => ({
      candidate,
      index,
      score: [...terms].reduce((score, term) => score + (candidate.toLowerCase().includes(term) ? 1 : 0), 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, relevantCount)
    .sort((left, right) => left.index - right.index)
    .map(({ candidate }) => candidate);
  return [...older, ...recent];
};
