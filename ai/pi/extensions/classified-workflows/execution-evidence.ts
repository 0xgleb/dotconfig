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
