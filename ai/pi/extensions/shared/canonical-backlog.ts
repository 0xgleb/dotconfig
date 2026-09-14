import { isAbsolute, normalize } from "node:path"

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,256}$/u
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const canonicalProject = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    !isAbsolute(value)
  )
    return false
  return (normalize(value).replace(/\/$/u, "") || "/") === value
}
const safeRequirement = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 4_000 &&
  !UNSAFE_CONTROL_CHARACTERS.test(value)

export const backlogRequirementsFromText = (
  text: string,
  maximumRequirements: number = Number.MAX_SAFE_INTEGER,
): readonly string[] => {
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(maximumRequirements) ||
    maximumRequirements < 0 ||
    UNSAFE_CONTROL_CHARACTERS.test(text)
  )
    return []
  const requirements: string[] = []
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 4_000, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1)))
      end -= 1
    const requirement = text.slice(offset, end)
    if (requirement.trim().length > 0) {
      if (requirements.length === maximumRequirements) return []
      requirements.push(requirement)
    }
    offset = end
  }
  return requirements
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

const safeRequirements = (values: readonly unknown[]): boolean => {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index) || !safeRequirement(values[index]))
      return false
  }
  return true
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
    !safeRequirements(value.requirements) ||
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

const canonicalBacklogItems = (
  scopeId: string,
  items: readonly unknown[],
): items is readonly CanonicalBacklogItemRecord[] => {
  const sourceIds = new Set<string>()
  const canonicalIds = new Set<string>()
  for (let index = 0; index < items.length; index += 1) {
    if (!Object.hasOwn(items, index)) return false
    const item = items[index]
    if (
      !canonicalBacklogItem(scopeId, item) ||
      sourceIds.has(item.sourceId) ||
      canonicalIds.has(item.canonicalId)
    )
      return false
    sourceIds.add(item.sourceId)
    canonicalIds.add(item.canonicalId)
  }
  return true
}

const recordFields = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    // Reflective access is an external boundary: getters and proxy traps may throw.
    try {
      if (Array.isArray(value)) return undefined
      if (Reflect.has(value, key)) result[key] = Reflect.get(value, key)
    } catch {
      return undefined
    }
  }
  return result
}

const arrayElements = (
  value: unknown,
  maximum: number,
): unknown[] | undefined => {
  let length: unknown
  try {
    if (!Array.isArray(value)) return undefined
    length = value.length
  } catch {
    return undefined
  }
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    typeof value !== "object" ||
    value === null
  )
    return undefined
  const elements: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    try {
      if (!Object.hasOwn(value, index)) return undefined
      elements.push(Reflect.get(value, String(index)))
    } catch {
      return undefined
    }
  }
  return elements
}

const snapshotFields = (
  input: unknown,
): Record<string, unknown> | undefined => {
  const value = recordFields(input, [
    "project",
    "source",
    "scopeId",
    "coverage",
    "observedAt",
    "items",
  ])
  if (!value) return undefined
  const rawItems = arrayElements(value.items, 5_000)
  if (!rawItems) return undefined
  const items: Record<string, unknown>[] = []
  for (const raw of rawItems) {
    const item = recordFields(raw, [
      "canonicalId",
      "sourceId",
      "requirements",
      "status",
      "priority",
      "reason",
    ])
    if (!item) return undefined
    const requirements = arrayElements(item.requirements, 32)
    if (!requirements) return undefined
    items.push({ ...item, requirements })
  }
  return { ...value, items }
}

export const decodeCanonicalBacklogSnapshot = (
  input: unknown,
): CanonicalBacklogSnapshot | undefined => {
  const value = snapshotFields(input)
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
  if (!canonicalBacklogItems(scopeId, value.items)) return undefined
  return {
    project: value.project,
    source: value.source,
    scopeId: value.scopeId,
    coverage: value.coverage,
    observedAt: value.observedAt,
    items: value.items,
  }
}
