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
