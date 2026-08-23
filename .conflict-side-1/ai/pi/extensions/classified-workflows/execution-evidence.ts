import { createHash } from "node:crypto"
import { sanitizeProcessDiagnostic } from "./protocol.ts"

const FIELD_PATTERN =
  /"(id|login|isResolved|databaseId|number|url)"\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+)/gi

export const boundedExecutionEvidence = (
  text: string,
  maxCharacters = 4_000,
): string => {
  const sanitized = sanitizeProcessDiagnostic(text).replace(/\s+/g, " ").trim()
  if (sanitized.length <= maxCharacters) return sanitized

  const fields: string[] = []
  for (const match of sanitized.matchAll(FIELD_PATTERN)) {
    fields.push(`${match[1]}=${match[2]}`)
    if (fields.length >= 120) break
  }
  const structured =
    fields.length > 0 ? ` [structured fields: ${fields.join(", ")}]` : ""
  if (structured) {
    const structuredTail = structured.slice(0, Math.max(0, maxCharacters - 64))
    const headLimit = Math.max(
      0,
      Math.min(192, maxCharacters - structuredTail.length - 24),
    )
    return `${sanitized.slice(0, headLimit)} …[bounded]${structuredTail}`.slice(
      0,
      maxCharacters,
    )
  }
  const half = Math.max(0, Math.floor((maxCharacters - 24) / 2))
  return `${sanitized.slice(0, half)} …[bounded] ${sanitized.slice(-half)}`.slice(
    0,
    maxCharacters,
  )
}

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
])

const evidenceTerms = (value: unknown): ReadonlySet<string> => {
  const serialized = JSON.stringify(value)?.toLowerCase() ?? ""
  const terms = (serialized.match(/[a-z0-9_./:#-]{4,}/g) ?? [])
    .map(term => term.replace(/^[-./:#]+|[-./:#]+$/g, ""))
    .filter(term => term.length >= 4 && !EVIDENCE_STOP_WORDS.has(term))
  return new Set(
    terms.flatMap(term => [
      term,
      ...term
        .split(/[./:#_-]+/g)
        .filter(
          component =>
            component.length >= 4 && !EVIDENCE_STOP_WORDS.has(component),
        ),
    ]),
  )
}

const focusedEvidenceTerms = (value: unknown): readonly string[] => {
  const serialized = JSON.stringify(value)?.toLowerCase() ?? ""
  return [
    ...new Set(
      (serialized.match(/[a-z0-9_./:#-]{3,}/g) ?? [])
        .map(term => term.replace(/^[-./:#]+|[-./:#]+$/g, ""))
        .filter(term => term.length >= 3 && !EVIDENCE_STOP_WORDS.has(term)),
    ),
  ].sort((left, right) => right.length - left.length)
}

/** Preserve the parts of a large result that share exact anchors with the proposed action. */
export const boundedRelevantExecutionEvidence = (
  text: string,
  subject: unknown,
  maxCharacters = 4_000,
): string => {
  const sanitized = sanitizeProcessDiagnostic(text).replace(/\s+/g, " ").trim()
  if (sanitized.length <= maxCharacters) return sanitized
  const lower = sanitized.toLowerCase()
  const windows: Array<{ start: number; end: number }> = []
  for (const term of focusedEvidenceTerms(subject)) {
    let offset = 0
    while (windows.length < 8) {
      const index = lower.indexOf(term, offset)
      if (index < 0) break
      const start = Math.max(0, index - 180)
      const end = Math.min(sanitized.length, index + term.length + 220)
      if (!windows.some(window => start <= window.end && end >= window.start))
        windows.push({ start, end })
      offset = index + term.length
    }
    if (windows.length >= 8) break
  }
  if (windows.length === 0)
    return boundedExecutionEvidence(sanitized, maxCharacters)
  const focused = windows
    .sort((left, right) => left.start - right.start)
    .map(({ start, end }) => sanitized.slice(start, end))
    .join(" … ")
  return `…[subject-focused] ${focused}`.slice(0, maxCharacters)
}

const canonicalInput: (value: unknown) => unknown = value => {
  if (Array.isArray(value)) return value.map(canonicalInput)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalInput(entry)]),
  )
}

export const toolInputDigest: (toolName: string, input: unknown) => string = (
  toolName,
  input,
) =>
  createHash("sha256")
    .update(toolName)
    .update("\0")
    .update(JSON.stringify(canonicalInput(input)) ?? "undefined")
    .digest("hex")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const missingInstructionPaths = (reason: string): readonly string[] => {
  if (
    !/(?:not|never|without|must|needs?\s+to).{0,48}(?:read|load(?:ed)?)|(?:read|load(?:ed)?).{0,48}(?:missing|required)/i.test(
      reason,
    )
  )
    return []
  return [
    ...new Set(
      (reason.match(/[a-z0-9._/-]+\/(?:AGENTS|SKILL)\.md/gi) ?? []).map(path =>
        path.replaceAll("\\", "/"),
      ),
    ),
  ]
}

/** A typed successful read of the exact named instruction file disproves only a classifier claim that it was unread. */
export const currentInstructionReadDisprovesMissingReadBlock = ({
  reason,
  branch,
}: {
  readonly reason: string
  readonly branch: readonly unknown[]
}): boolean => {
  const missingPaths = missingInstructionPaths(reason)
  if (missingPaths.length === 0) return false

  const readPathsByCallId = new Map<string, string>()
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue
    const message = entry.message
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (
        !isRecord(part) ||
        part.type !== "toolCall" ||
        typeof part.id !== "string" ||
        (part.name !== "read" && part.name !== "functions.read") ||
        !isRecord(part.arguments) ||
        typeof part.arguments.path !== "string"
      )
        continue
      readPathsByCallId.set(part.id, part.arguments.path.replaceAll("\\", "/"))
    }
  }

  return branch.some(entry => {
    if (!isRecord(entry) || entry.type !== "message") return false
    const message = entry.message
    if (
      !isRecord(message) ||
      message.role !== "toolResult" ||
      message.isError !== false ||
      typeof message.toolCallId !== "string"
    )
      return false
    const readPath = readPathsByCallId.get(message.toolCallId)
    return (
      readPath !== undefined &&
      missingPaths.some(missingPath => readPath.endsWith(missingPath))
    )
  })
}

export interface ToolResultExecutionEvidenceInput {
  readonly toolName: unknown
  readonly text: string
  readonly isError: unknown
  readonly input?: unknown
  readonly inputDigest?: string
  readonly subject: unknown
  readonly maxCharacters?: number
}

/** Preserve execution status separately from untrusted result wording. */
export const toolResultExecutionEvidence: (
  input: ToolResultExecutionEvidenceInput,
) => string = ({
  toolName,
  text,
  isError,
  input,
  inputDigest,
  subject,
  maxCharacters = 2_400,
}) => {
  const name =
    sanitizeProcessDiagnostic(String(toolName ?? "tool"))
      .replace(/\s+/g, " ")
      .slice(0, 64) || "tool"
  const status =
    isError === true ? "error" : isError === false ? "success" : "unknown"
  const digestIdentity =
    inputDigest && /^[0-9a-f]{64}$/.test(inputDigest)
      ? ` inputDigest=${inputDigest}`
      : ""
  const inputRecord =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  const selectedInput = inputRecord
    ? Object.fromEntries(
        ["action", "command", "file_path", "id", "limit", "offset", "path"]
          .filter(key => inputRecord[key] !== undefined)
          .map(key => [key, inputRecord[key]]),
      )
    : {}
  const encodedInput = sanitizeProcessDiagnostic(JSON.stringify(selectedInput))
    .replace(/\s+/g, " ")
    .slice(0, 1_000)
  const inputIdentity = encodedInput !== "{}" ? ` input=${encodedInput}` : ""
  const evidenceText = text.trim() || "(no textual output)"
  return `${name} result status=${status}${digestIdentity}${inputIdentity}: ${boundedRelevantExecutionEvidence(evidenceText, subject, maxCharacters)}`
}

const supersededFailureIndexes = (
  candidates: readonly string[],
): ReadonlySet<number> => {
  const laterSuccessfulInputs = new Set<string>()
  const superseded = new Set<number>()
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index] ?? ""
    const match = candidate.match(
      /^\S+ result status=(success|error) inputDigest=([0-9a-f]{64})\b/,
    )
    if (!match) continue
    const [, status, inputDigest] = match
    if (!inputDigest) continue
    if (status === "success") laterSuccessfulInputs.add(inputDigest)
    else if (laterSuccessfulInputs.has(inputDigest)) superseded.add(index)
  }
  return superseded
}

/** Keep a small recency window plus older evidence that shares concrete identifiers with the proposed boundary. */
export const selectRelevantExecutionEvidence = (
  candidates: readonly string[],
  subject: unknown,
  recentCount = 8,
  relevantCount = 8,
): readonly string[] => {
  const superseded = supersededFailureIndexes(candidates)
  const currentCandidates = candidates.filter(
    (_, index) => !superseded.has(index),
  )
  const recentStart = Math.max(0, currentCandidates.length - recentCount)
  const recent = currentCandidates.slice(recentStart)
  const terms = evidenceTerms(subject)
  const olderCandidates = currentCandidates.slice(0, recentStart)
  const scoredOlderCandidates = olderCandidates.map((candidate, index) => ({
    candidate,
    index,
    score: [...terms].reduce(
      (score, term) => score + (candidate.toLowerCase().includes(term) ? 1 : 0),
      0,
    ),
  }))
  const selectedOlderIndexes = new Set(
    scoredOlderCandidates
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) => right.score - left.score || right.index - left.index,
      )
      .slice(0, relevantCount)
      .map(({ index }) => index),
  )
  const ttddRedPhaseIndexes = scoredOlderCandidates
    .filter(
      ({ candidate, score }) =>
        score > 0 &&
        /^bash result status=error\b/i.test(candidate) &&
        /\b(?:cargo\s+(?:nextest\s+run|test)|nextest\s+run|bun\s+(?:run\s+)?test|pnpm\s+test|npm\s+test|pytest)\b/i.test(
          candidate,
        ),
    )
    .slice(-4)
    .map(({ index }) => index)
  for (const index of ttddRedPhaseIndexes) selectedOlderIndexes.add(index)
  const vcsTopologyIndexes = olderCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      /\b(?:gt parent|git merge-base|git branch --show-current|git rev-parse --abbrev-ref)\b/i.test(
        candidate,
      ),
    )
    .slice(-4)
    .map(({ index }) => index)
  for (const index of vcsTopologyIndexes) selectedOlderIndexes.add(index)
  const instructionReadIndexes = olderCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      /^(?:functions\.)?read result status=success\b.*\binput=.*(?:AGENTS|SKILL)\.md/i.test(
        candidate,
      ),
    )
    .slice(-4)
    .map(({ index }) => index)
  for (const index of instructionReadIndexes) selectedOlderIndexes.add(index)
  const older = olderCandidates.filter((_candidate, index) =>
    selectedOlderIndexes.has(index),
  )
  return [...older, ...recent]
}
