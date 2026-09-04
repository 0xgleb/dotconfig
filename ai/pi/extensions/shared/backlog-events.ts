import { isAbsolute, normalize } from "node:path"

export const BACKLOG_PROJECTION_EVENT = "pi:backlog-projection"
export const BRANCH_TODO_BACKLOG_EVENT = "pi:branch-todo-backlog"

export type BranchTodoBacklogStatus =
  | "pending"
  | "in_progress"
  | "in_review"
  | "completed"
  | "cancelled"
  | "blocked"
  | "deferred"

export interface BranchTodoBacklogRecord {
  readonly canonicalId: string
  readonly sourceId: string
  readonly requirements: readonly string[]
  readonly status: BranchTodoBacklogStatus
  readonly reason?: string
}

export interface BranchTodoBacklogSnapshot {
  readonly project: string
  readonly sessionId: string
  readonly observedAt: number
  readonly todos: readonly BranchTodoBacklogRecord[]
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,256}$/u
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const canonicalProject = (value: unknown): value is string => {
  if (typeof value !== "string" || !isAbsolute(value)) return false
  return (normalize(value).replace(/\/$/u, "") || "/") === value
}
const BRANCH_TODO_STATUSES: readonly BranchTodoBacklogStatus[] = [
  "pending",
  "in_progress",
  "in_review",
  "completed",
  "cancelled",
  "blocked",
  "deferred",
]

const branchTodoStatus = (value: unknown): value is BranchTodoBacklogStatus =>
  BRANCH_TODO_STATUSES.some(status => status === value)

const safeRequirement = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 4_000 &&
  !UNSAFE_CONTROL_CHARACTERS.test(value)

export const backlogRequirementsFromText = (
  text: string,
): readonly string[] => {
  if (UNSAFE_CONTROL_CHARACTERS.test(text)) return []
  return (text.match(/[\s\S]{1,4000}/gu) ?? []).filter(
    requirement => requirement.trim().length > 0,
  )
}

const branchTodoRecord = (value: unknown): value is BranchTodoBacklogRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  if (
    !("canonicalId" in value) ||
    !("sourceId" in value) ||
    !("requirements" in value) ||
    !("status" in value) ||
    typeof value.canonicalId !== "string" ||
    typeof value.sourceId !== "string" ||
    !SAFE_IDENTIFIER.test(value.canonicalId) ||
    !SAFE_IDENTIFIER.test(value.sourceId) ||
    !value.sourceId.startsWith(`${value.canonicalId}:`) ||
    !Array.isArray(value.requirements) ||
    value.requirements.length === 0 ||
    value.requirements.length > 32 ||
    !value.requirements.every(safeRequirement) ||
    !branchTodoStatus(value.status)
  )
    return false
  if (value.status === "blocked")
    return (
      "reason" in value &&
      typeof value.reason === "string" &&
      safeRequirement(value.reason)
    )
  return !("reason" in value) || value.reason === undefined
}

export const decodeBranchTodoBacklogSnapshot = (
  value: unknown,
): BranchTodoBacklogSnapshot | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("project" in value) ||
    !("sessionId" in value) ||
    !("observedAt" in value) ||
    !("todos" in value) ||
    !canonicalProject(value.project) ||
    typeof value.sessionId !== "string" ||
    !SAFE_IDENTIFIER.test(value.sessionId) ||
    typeof value.observedAt !== "number" ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 ||
    !Array.isArray(value.todos) ||
    value.todos.length > 5_000 ||
    !value.todos.every(branchTodoRecord)
  )
    return undefined
  const sourceIds = value.todos.map(todo => todo.sourceId)
  const canonicalIds = value.todos.map(todo => todo.canonicalId)
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(canonicalIds).size !== canonicalIds.length
  )
    return undefined
  return {
    project: value.project,
    sessionId: value.sessionId,
    observedAt: value.observedAt,
    todos: value.todos,
  }
}

export const CANONICAL_BACKLOG_EVENT = "pi:canonical-backlog"

export type CanonicalBacklogSource = "tracker-item" | "backlog-document"
export type CanonicalBacklogStatus =
  "ready" | "blocked" | "completed" | "cancelled"

export interface CanonicalBacklogItemRecord {
  readonly canonicalId: string
  readonly sourceId: string
  readonly requirements: readonly string[]
  readonly status: CanonicalBacklogStatus
  readonly priority: "normal" | "urgent"
  readonly reason?: string
}

export interface CanonicalBacklogSnapshot {
  readonly project: string
  readonly source: CanonicalBacklogSource
  readonly scopeId: string
  readonly coverage: "partial" | "complete"
  readonly observedAt: number
  readonly items: readonly CanonicalBacklogItemRecord[]
}

const canonicalBacklogItem = (
  scopeId: string,
  value: unknown,
): value is CanonicalBacklogItemRecord => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("canonicalId" in value) ||
    !("sourceId" in value) ||
    !("requirements" in value) ||
    !("status" in value) ||
    !("priority" in value) ||
    typeof value.canonicalId !== "string" ||
    typeof value.sourceId !== "string" ||
    !SAFE_IDENTIFIER.test(value.canonicalId) ||
    !SAFE_IDENTIFIER.test(value.sourceId) ||
    !value.sourceId.startsWith(`${scopeId}:${value.canonicalId}:`) ||
    !Array.isArray(value.requirements) ||
    value.requirements.length === 0 ||
    value.requirements.length > 32 ||
    !value.requirements.every(safeRequirement) ||
    (value.status !== "ready" &&
      value.status !== "blocked" &&
      value.status !== "completed" &&
      value.status !== "cancelled") ||
    (value.priority !== "normal" && value.priority !== "urgent")
  )
    return false
  if (value.status === "blocked")
    return (
      "reason" in value &&
      typeof value.reason === "string" &&
      safeRequirement(value.reason)
    )
  return !("reason" in value) || value.reason === undefined
}

export const decodeCanonicalBacklogSnapshot = (
  value: unknown,
): CanonicalBacklogSnapshot | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("project" in value) ||
    !("source" in value) ||
    !("scopeId" in value) ||
    !("coverage" in value) ||
    !("observedAt" in value) ||
    !("items" in value) ||
    !canonicalProject(value.project) ||
    (value.source !== "tracker-item" && value.source !== "backlog-document") ||
    typeof value.scopeId !== "string" ||
    !SAFE_IDENTIFIER.test(value.scopeId) ||
    (value.coverage !== "partial" && value.coverage !== "complete") ||
    typeof value.observedAt !== "number" ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > 5_000
  )
    return undefined
  const scopeId = value.scopeId
  if (!value.items.every(item => canonicalBacklogItem(scopeId, item)))
    return undefined
  const sourceIds = value.items.map(item => item.sourceId)
  const canonicalIds = value.items.map(item => item.canonicalId)
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(canonicalIds).size !== canonicalIds.length
  )
    return undefined
  return {
    project: value.project,
    source: value.source,
    scopeId: value.scopeId,
    coverage: value.coverage,
    observedAt: value.observedAt,
    items: value.items,
  }
}

export const MESSAGE_BACKLOG_EVENT = "pi:message-backlog"

export interface MessageBacklogRecord {
  readonly project: string
  readonly messageId: string
  readonly observedAt: number
  readonly source: "owner-message" | "bridge-message"
  readonly authority: "authenticated-owner" | "routing-only"
  readonly requirements: readonly string[]
}

export const decodeMessageBacklogRecord = (
  value: unknown,
): MessageBacklogRecord | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("project" in value) ||
    !("messageId" in value) ||
    !("observedAt" in value) ||
    !("source" in value) ||
    !("authority" in value) ||
    !("requirements" in value) ||
    !canonicalProject(value.project) ||
    typeof value.messageId !== "string" ||
    !SAFE_IDENTIFIER.test(value.messageId) ||
    typeof value.observedAt !== "number" ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 ||
    !Array.isArray(value.requirements) ||
    value.requirements.length === 0 ||
    value.requirements.length > 32 ||
    !value.requirements.every(safeRequirement)
  )
    return undefined
  const base = {
    project: value.project,
    messageId: value.messageId,
    observedAt: value.observedAt,
    requirements: value.requirements,
  }
  if (value.source === "owner-message")
    return value.authority === "authenticated-owner"
      ? {
          ...base,
          source: "owner-message",
          authority: "authenticated-owner",
        }
      : undefined
  if (value.source === "bridge-message")
    return value.authority === "routing-only"
      ? { ...base, source: "bridge-message", authority: "routing-only" }
      : undefined
  return undefined
}

export type BacklogSourceCoverage =
  | "owner-message"
  | "bridge-message"
  | "registry-request"
  | "branch-todo"
  | "tracker-item"
  | "backlog-document"

export interface ExternalBacklogProjection {
  readonly project: string
  readonly actionable: number
  readonly blocked: number
  readonly unreconciled: number
  readonly totalOpen: number
  readonly unreconciledSources: readonly BacklogSourceCoverage[]
  readonly observedAt: number
}

const SOURCE_COVERAGE: readonly BacklogSourceCoverage[] = [
  "owner-message",
  "bridge-message",
  "registry-request",
  "branch-todo",
  "tracker-item",
  "backlog-document",
]

const boundedCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1_000_000

const sourceCoverage = (value: unknown): value is BacklogSourceCoverage =>
  SOURCE_COVERAGE.some(source => source === value)

export const decodeExternalBacklogProjection = (
  value: unknown,
): ExternalBacklogProjection | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("project" in value) ||
    !("actionable" in value) ||
    !("blocked" in value) ||
    !("unreconciled" in value) ||
    !("totalOpen" in value) ||
    !("unreconciledSources" in value) ||
    !("observedAt" in value)
  )
    return undefined
  const sources = value.unreconciledSources
  if (
    !canonicalProject(value.project) ||
    !boundedCount(value.actionable) ||
    !boundedCount(value.blocked) ||
    !boundedCount(value.unreconciled) ||
    !boundedCount(value.totalOpen) ||
    typeof value.observedAt !== "number" ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 ||
    !Array.isArray(sources) ||
    sources.length > SOURCE_COVERAGE.length ||
    !sources.every(sourceCoverage) ||
    new Set(sources).size !== sources.length
  )
    return undefined
  if (value.actionable + value.blocked + value.unreconciled > value.totalOpen)
    return undefined
  return {
    project: value.project,
    actionable: value.actionable,
    blocked: value.blocked,
    unreconciled: value.unreconciled,
    totalOpen: value.totalOpen,
    unreconciledSources: sources,
    observedAt: value.observedAt,
  }
}
