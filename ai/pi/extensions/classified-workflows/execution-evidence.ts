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
  "inputdigest",
  "result",
  "scope",
  "snapshot",
  "status",
  "success",
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
  readonly scope?: string
  readonly maxCharacters?: number
}

interface StateSnapshotIdentity {
  readonly kind:
    | "git-status"
    | "git-path-status"
    | "gitbutler-status"
    | "pull-request-view"
    | "registry-completion"
    | "registry-version"
    | "git-current-branch"
    | "git-head"
    | "git-history"
    | "git-push"
    | "git-remote-sha"
  readonly anchor?: string
}

const hashedSnapshotAnchor = (label: string, value: string): string =>
  `${label}:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`

const boundedOnelineHistoryCount = (command: string): number | undefined => {
  const tokens = command.split(/\s+/)
  if (!/^(?:\^)?git$/i.test(tokens[0] ?? "") || tokens[1] !== "log")
    return undefined
  let oneline = false
  const counts: number[] = []
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ""
    if (token === "--oneline" && !oneline) {
      oneline = true
      continue
    }
    const shortCount = /^-(\d{1,2})$/.exec(token)?.[1]
    const equalsCount = /^--max-count=(\d{1,2})$/.exec(token)?.[1]
    if (shortCount || equalsCount) {
      counts.push(Number(shortCount ?? equalsCount))
      continue
    }
    if (token === "--max-count" && /^\d{1,2}$/.test(tokens[index + 1] ?? "")) {
      counts.push(Number(tokens[index + 1]))
      index += 1
      continue
    }
    return undefined
  }
  return oneline && counts.length === 1 && (counts[0] ?? 0) <= 50
    ? counts[0]
    : undefined
}

const safeRelativeStatusPaths = (
  pathspec: string,
): readonly string[] | undefined => {
  const paths = pathspec.split(/\s+/).filter(Boolean)
  return paths.length > 0 &&
    paths.every(
      path =>
        !path.startsWith("-") &&
        !path.startsWith("/") &&
        !path.split("/").includes(".."),
    )
    ? paths
    : undefined
}

const GIT_STATUS_OPTIONS = new Set([
  "--short",
  "-s",
  "--branch",
  "-b",
  "--porcelain",
  "--porcelain=v1",
  "--porcelain=v2",
  "--untracked-files=no",
  "--untracked-files=normal",
  "--untracked-files=all",
  "--ignore-submodules=none",
  "--ignore-submodules=untracked",
  "--ignore-submodules=dirty",
  "--ignore-submodules=all",
])

const gitStatusPaths = (
  command: string,
): readonly string[] | null | undefined => {
  const tokens = command.split(/\s+/)
  if (!/^(?:\^)?git$/i.test(tokens[0] ?? "") || tokens[1] !== "status")
    return undefined
  const paths: string[] = []
  let readingPaths = false
  for (const token of tokens.slice(2)) {
    if (!readingPaths && token === "--") {
      readingPaths = true
      continue
    }
    if (!readingPaths && GIT_STATUS_OPTIONS.has(token)) continue
    if (token.startsWith("-")) return undefined
    readingPaths = true
    paths.push(token)
  }
  if (paths.length === 0) return null
  return safeRelativeStatusPaths(paths.join(" "))
}

const stateSnapshotIdentity = (
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
  scope: string | undefined,
): StateSnapshotIdentity | undefined => {
  const normalizedToolName = toolName.replace(/^functions\./, "")
  if (normalizedToolName === "agent_registry") {
    if (
      input?.action === "complete_request" &&
      typeof input.requestId === "string" &&
      /^[a-z0-9-]{4,80}$/i.test(input.requestId)
    )
      return {
        kind: "registry-completion",
        anchor: `request:${input.requestId.toLowerCase()}`,
      }
    if (
      input?.action === "list" &&
      typeof input.project === "string" &&
      input.project === scope
    )
      return {
        kind: "registry-version",
        anchor: hashedSnapshotAnchor("project", input.project),
      }
    return undefined
  }
  if (normalizedToolName !== "bash" || typeof input?.command !== "string")
    return undefined
  const command = input.command.trim()
  if (!/^[a-z0-9_./,:#= -]+$/i.test(command)) return undefined
  const statusPaths = gitStatusPaths(command)
  if (statusPaths === null) return { kind: "git-status" }
  if (statusPaths)
    return {
      kind: "git-path-status",
      anchor: `paths:${createHash("sha256").update(statusPaths.join("\0")).digest("hex").slice(0, 16)}`,
    }
  if (/^(?:\^)?but\s+status(?:\s+[^;&|`<>\n]+)?$/i.test(command))
    return { kind: "gitbutler-status" }
  if (/^(?:\^)?git\s+branch\s+--show-current$/i.test(command))
    return { kind: "git-current-branch" }
  if (/^(?:\^)?git\s+rev-parse(?:\s+--verify)?\s+HEAD$/i.test(command))
    return { kind: "git-head" }
  if (boundedOnelineHistoryCount(command) !== undefined)
    return { kind: "git-history" }
  if (
    /^(?:\^)?git\s+push(?:\s+(?:-u|--set-upstream))?\s+[a-z0-9_][a-z0-9_.-]*\s+[a-z0-9_][a-z0-9_./-]*$/i.test(
      command,
    )
  )
    return {
      kind: "git-push",
      anchor: hashedSnapshotAnchor("command", command),
    }
  if (
    /^(?:\^)?git\s+ls-remote\s+[a-z0-9_.-]+\s+refs\/heads\/[a-z0-9_./-]+$/i.test(
      command,
    )
  )
    return {
      kind: "git-remote-sha",
      anchor: hashedSnapshotAnchor("command", command),
    }
  const pullRequest = /^(?:\^)?gh\s+pr\s+view\s+#?(\d+)\b([^;&|`<>\n]*)$/i.exec(
    command,
  )
  return pullRequest &&
    !/(?:^|\s)(?:--repo(?:\s|=)|-R(?:\s|=|\S))/i.test(pullRequest[2] ?? "")
    ? { kind: "pull-request-view", anchor: `pr:${pullRequest[1]}` }
    : undefined
}

const evidenceScopeDigest = (scope: string): string =>
  createHash("sha256").update(scope).digest("hex").slice(0, 16)

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
  scope,
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
        [
          "action",
          "command",
          "file_path",
          "id",
          "limit",
          "offset",
          "path",
          "project",
          "requestId",
        ]
          .filter(key => inputRecord[key] !== undefined)
          .map(key => [key, inputRecord[key]]),
      )
    : {}
  const encodedInput = sanitizeProcessDiagnostic(JSON.stringify(selectedInput))
    .replace(/\s+/g, " ")
    .slice(0, 1_000)
  const inputIdentity = encodedInput !== "{}" ? ` input=${encodedInput}` : ""
  const snapshot =
    status === "success"
      ? stateSnapshotIdentity(name, inputRecord, scope)
      : undefined
  const scopeIdentity = scope ? ` scope=${evidenceScopeDigest(scope)}` : ""
  const snapshotMarker = snapshot
    ? ` snapshot=${snapshot.kind}${snapshot.anchor ? ` anchor=${snapshot.anchor}` : ""}`
    : ""
  const evidenceText = text.trim() || "(no textual output)"
  return `${name} result status=${status}${digestIdentity}${scopeIdentity}${snapshotMarker}${inputIdentity}: ${boundedRelevantExecutionEvidence(evidenceText, subject, maxCharacters)}`
}

export const branchExecutionEvidence = ({
  branch,
  subject,
  scope,
  maxCharacters = 2_400,
}: {
  readonly branch: readonly unknown[]
  readonly subject: unknown
  readonly scope: string
  readonly maxCharacters?: number
}): readonly string[] => {
  const toolCalls = new Map<
    string,
    { readonly input: unknown; readonly digest: string }
  >()
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
        typeof part.name !== "string"
      )
        continue
      toolCalls.set(part.id, {
        input: part.arguments,
        digest: toolInputDigest(part.name, part.arguments),
      })
    }
  }

  return branch.flatMap(entry => {
    if (!isRecord(entry) || entry.type !== "message") return []
    const message = entry.message
    if (!isRecord(message)) return []
    if (message.role === "assistant") {
      const text = Array.isArray(message.content)
        ? message.content
            .flatMap(part =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("\n")
        : typeof message.content === "string"
          ? message.content
          : ""
      return text
        ? [
            `assistant report (untrusted): ${boundedRelevantExecutionEvidence(text, subject, maxCharacters)}`,
          ]
        : []
    }
    if (message.role !== "toolResult") return []
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap(part =>
                isRecord(part) &&
                part.type === "text" &&
                typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : ""
    const toolCall =
      typeof message.toolCallId === "string"
        ? toolCalls.get(message.toolCallId)
        : undefined
    return [
      toolResultExecutionEvidence({
        toolName: message.toolName,
        text,
        isError: message.isError,
        input: toolCall?.input,
        inputDigest: toolCall?.digest,
        subject,
        scope,
        maxCharacters,
      }),
    ]
  })
}

const supersededFailureIndexes = (
  candidates: readonly string[],
): ReadonlySet<number> => {
  const laterSuccessfulInputs = new Set<string>()
  const superseded = new Set<number>()
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index] ?? ""
    const match = candidate.match(
      /^\S+ result status=(success|error) inputDigest=([0-9a-f]{64})(?: scope=([0-9a-f]{16}))?\b/,
    )
    if (!match) continue
    const [, status, inputDigest, scope] = match
    if (!inputDigest) continue
    const identity = `${inputDigest}:${scope ?? "legacy"}`
    if (status === "success") laterSuccessfulInputs.add(identity)
    else if (laterSuccessfulInputs.has(identity)) superseded.add(index)
  }
  return superseded
}

const STATE_SNAPSHOT_MARKER =
  /^(?:functions\.)?\S+ result status=success(?: inputDigest=[0-9a-f]{64})? scope=([0-9a-f]{16}) snapshot=(git-status|git-path-status|gitbutler-status|pull-request-view|registry-completion|registry-version|git-current-branch|git-head|git-history|git-push|git-remote-sha)(?: anchor=([a-z0-9_./:-]{1,128}))?\b/i

interface StateSnapshotMarker {
  readonly kind: string
  readonly scope: string
  readonly anchor?: string
}

const stateSnapshotMarker = (
  candidate: string,
): StateSnapshotMarker | undefined => {
  const match = STATE_SNAPSHOT_MARKER.exec(candidate)
  if (!match?.[1] || !match[2]) return undefined
  return {
    kind: match[2],
    scope: match[1],
    ...(match[3] ? { anchor: match[3] } : {}),
  }
}

/** Keep a small recency window plus older evidence that shares concrete identifiers with the proposed boundary. */
export const selectRelevantExecutionEvidence = (
  candidates: readonly string[],
  subject: unknown,
  recentCount = 8,
  relevantCount = 8,
): readonly string[] => {
  const superseded = supersededFailureIndexes(candidates)
  const nonSupersededCandidates = candidates.filter(
    (_, index) => !superseded.has(index),
  )
  const subjectScope =
    isRecord(subject) && typeof subject.cwd === "string"
      ? evidenceScopeDigest(subject.cwd)
      : undefined
  const supersededSnapshotIndexes = new Set<number>()
  if (subjectScope) {
    const latestSnapshotIndexes = new Map<string, number>()
    nonSupersededCandidates.forEach((candidate, index) => {
      const marker = stateSnapshotMarker(candidate)
      if (!marker || marker.scope !== subjectScope) return
      const identity = `${marker.kind}:${marker.anchor ?? "scope"}`
      const prior = latestSnapshotIndexes.get(identity)
      if (prior !== undefined) supersededSnapshotIndexes.add(prior)
      latestSnapshotIndexes.set(identity, index)
    })
  }
  const currentCandidates = nonSupersededCandidates.filter(
    (candidate, index) => {
      if (supersededSnapshotIndexes.has(index)) return false
      const marker = stateSnapshotMarker(candidate)
      return !subjectScope || !marker || marker.scope === subjectScope
    },
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
  if (subjectScope) {
    const latestSnapshotByKind = new Map<string, number>()
    const scopedSnapshotIndexes: number[] = []
    olderCandidates.forEach((candidate, index) => {
      const marker = stateSnapshotMarker(candidate)
      if (marker?.scope !== subjectScope) return
      latestSnapshotByKind.set(marker.kind, index)
      scopedSnapshotIndexes.push(index)
    })
    for (const index of latestSnapshotByKind.values())
      selectedOlderIndexes.add(index)
    for (const index of scopedSnapshotIndexes.slice(-8))
      selectedOlderIndexes.add(index)
  }
  const older = olderCandidates.filter((_candidate, index) =>
    selectedOlderIndexes.has(index),
  )
  return [...older, ...recent]
}
