import { isAbsolute, normalize } from "node:path"

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,256}$/u
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const canonicalProject = (value: unknown): value is string => {
  if (typeof value !== "string" || !isAbsolute(value)) return false
  return (normalize(value).replace(/\/$/u, "") || "/") === value
}
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
