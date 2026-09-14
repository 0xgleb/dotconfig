import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { Data, Effect } from "effect"

import {
  backlogRequirementsFromText,
  decodeCanonicalBacklogSnapshot,
  type CanonicalBacklogItemRecord,
  type CanonicalBacklogSnapshot,
  type CanonicalBacklogStatus,
} from "./canonical-backlog.ts"

export class BacklogSourceAdapterError extends Data.TaggedError(
  "BacklogSourceAdapterError",
)<{
  readonly code: "internal_failure" | "invalid_input" | "malformed_declaration"
  readonly message: string
}> {}

export interface GitHubTrackerItemInput {
  readonly kind: "issue" | "pull-request"
  readonly number: number
  readonly title: string
  readonly body?: string
  readonly state: "open" | "closed" | "merged"
  readonly stateReason?: "completed" | "not-planned"
  readonly labels: readonly string[]
  readonly blockedReason?: string
  readonly updatedAt: string
}

export interface GitHubTrackerSnapshotInput {
  readonly project: string
  readonly repository: string
  readonly observedAt: number
  readonly coverage: "partial" | "complete"
  readonly items: readonly GitHubTrackerItemInput[]
}

export interface BacklogDocumentSnapshotInput {
  readonly project: string
  readonly documentId: string
  readonly observedAt: number
  readonly content: string
}

interface BacklogDocumentDeclaration {
  readonly id: string
  readonly status: CanonicalBacklogStatus
  readonly priority: "normal" | "urgent"
  readonly requirements: readonly string[]
  readonly reason?: string
}

const MAX_ITEMS = 5_000
const MAX_REQUIREMENTS = 32
const MAX_REQUIREMENT_CHARACTERS = 4_000
const MAX_DOCUMENT_CHARACTERS = 4 * 1_024 * 1_024
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,256}$/u
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const COMPLETE_DOCUMENT_MARKER = "<!-- pi-backlog:complete -->"
const DOCUMENT_FENCE = /```pi-backlog[ \t]*\r?\n([\s\S]*?)\r?\n```/gu
const DOCUMENT_FENCE_START = /```pi-backlog[ \t]*(?:\r?\n|$)/gu

const adapterError = (
  code: BacklogSourceAdapterError["code"],
  message: string,
): BacklogSourceAdapterError => new BacklogSourceAdapterError({ code, message })

const field = (
  value: unknown,
  key: string,
): Effect.Effect<unknown, BacklogSourceAdapterError> =>
  Effect.try({
    try: (): unknown =>
      typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined,
    catch: () => adapterError("invalid_input", "input property cannot be read"),
  })

const inputElements = (
  value: unknown,
  maximum: number,
): Effect.Effect<readonly unknown[], BacklogSourceAdapterError> =>
  Effect.gen(function* () {
    const shape = yield* Effect.try({
      try: ():
        | { readonly values: readonly unknown[]; readonly length: unknown }
        | undefined =>
        Array.isArray(value)
          ? { values: value, length: value.length }
          : undefined,
      catch: () => adapterError("invalid_input", "input array cannot be read"),
    })
    if (
      !shape ||
      typeof shape.length !== "number" ||
      !Number.isSafeInteger(shape.length) ||
      shape.length < 0 ||
      shape.length > maximum
    )
      return yield* Effect.fail(
        adapterError("invalid_input", "input array size is invalid"),
      )
    const elements: unknown[] = []
    for (let index = 0; index < shape.length; index += 1) {
      const slot = yield* Effect.try({
        try: () =>
          Object.hasOwn(shape.values, index)
            ? { value: shape.values[index] }
            : undefined,
        catch: () =>
          adapterError("invalid_input", "input array element cannot be read"),
      })
      if (!slot)
        return yield* Effect.fail(
          adapterError(
            "invalid_input",
            "input array contains a missing element",
          ),
        )
      elements.push(slot.value)
    }
    return elements
  })

const boundedSafeText = (
  label: string,
  value: unknown,
  maximum: number,
): Effect.Effect<string, BacklogSourceAdapterError> => {
  if (typeof value !== "string")
    return Effect.fail(adapterError("invalid_input", `${label} is not text`))
  const text = value.trim()
  return text.length === 0 ||
    value.length > maximum ||
    UNSAFE_CONTROL_CHARACTERS.test(value)
    ? Effect.fail(
        adapterError("invalid_input", `${label} is not bounded safe text`),
      )
    : Effect.succeed(text)
}

const validObservedAt = (
  value: unknown,
): Effect.Effect<number, BacklogSourceAdapterError> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        adapterError("invalid_input", "observedAt must be a timestamp"),
      )

const validProject = (
  value: unknown,
): Effect.Effect<string, BacklogSourceAdapterError> =>
  Effect.flatMap(boundedSafeText("project", value, 1_024), project =>
    isAbsolute(project)
      ? Effect.succeed(project)
      : Effect.fail(
          adapterError("invalid_input", "project must be an absolute path"),
        ),
  )

const digest = (
  value: unknown,
): Effect.Effect<string, BacklogSourceAdapterError> =>
  Effect.try({
    try: () =>
      createHash("sha256")
        .update(JSON.stringify(value))
        .digest("hex")
        .slice(0, 20),
    catch: () =>
      adapterError("internal_failure", "backlog source digest failed"),
  })

const canonicalSnapshot = (
  value: CanonicalBacklogSnapshot,
): Effect.Effect<CanonicalBacklogSnapshot, BacklogSourceAdapterError> => {
  const decoded = decodeCanonicalBacklogSnapshot(value)
  return decoded
    ? Effect.succeed(decoded)
    : Effect.fail(
        adapterError(
          "invalid_input",
          "adapter output violates the canonical backlog contract",
        ),
      )
}

const requirementPages = (
  title: unknown,
  body: unknown,
): Effect.Effect<readonly string[], BacklogSourceAdapterError> =>
  Effect.gen(function* () {
    const titleRequirement = yield* boundedSafeText(
      "tracker title",
      title,
      MAX_REQUIREMENT_CHARACTERS,
    )
    if (body !== undefined && typeof body !== "string")
      return yield* Effect.fail(
        adapterError("invalid_input", "tracker body is not text"),
      )
    const bodyRequirements =
      body === undefined || body.trim().length === 0
        ? []
        : backlogRequirementsFromText(body, MAX_REQUIREMENTS - 1)
    if (
      body !== undefined &&
      body.trim().length > 0 &&
      bodyRequirements.length === 0
    )
      return yield* Effect.fail(
        adapterError("invalid_input", "tracker body is not bounded safe text"),
      )
    const requirements = [titleRequirement, ...bodyRequirements]
    return requirements.length <= MAX_REQUIREMENTS
      ? requirements
      : yield* Effect.fail(
          adapterError(
            "invalid_input",
            "tracker item has too many requirements",
          ),
        )
  })

const trackerStatus = (
  kind: GitHubTrackerItemInput["kind"],
  state: GitHubTrackerItemInput["state"],
  stateReason: GitHubTrackerItemInput["stateReason"],
  blockedReason: unknown,
  labels: ReadonlySet<string>,
): Effect.Effect<
  { readonly status: CanonicalBacklogStatus; readonly reason?: string },
  BacklogSourceAdapterError
> =>
  Effect.gen(function* () {
    if (kind === "issue" && state === "merged")
      return yield* Effect.fail(
        adapterError("invalid_input", "an issue cannot have merged state"),
      )
    if (state === "merged") return { status: "completed" }
    if (state === "closed")
      return {
        status:
          kind === "issue" && stateReason !== "not-planned"
            ? "completed"
            : "cancelled",
      }
    if (!labels.has("blocked")) return { status: "ready" }
    return {
      status: "blocked",
      reason:
        blockedReason === undefined
          ? "GitHub label: blocked"
          : yield* boundedSafeText(
              "tracker blocked reason",
              blockedReason,
              MAX_REQUIREMENT_CHARACTERS,
            ),
    }
  })

const urgentTrackerItem = (labels: ReadonlySet<string>): boolean =>
  ["urgent", "priority:urgent", "p0", "p1"].some(label => labels.has(label))

const githubTrackerItem = (
  value: unknown,
  scopeId: string,
): Effect.Effect<CanonicalBacklogItemRecord, BacklogSourceAdapterError> =>
  Effect.gen(function* () {
    const kind = yield* field(value, "kind")
    const number = yield* field(value, "number")
    const state = yield* field(value, "state")
    const stateReason = yield* field(value, "stateReason")
    const rawLabels = yield* field(value, "labels")
    if (
      (kind !== "issue" && kind !== "pull-request") ||
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > 1_000_000_000 ||
      (state !== "open" && state !== "closed" && state !== "merged") ||
      (stateReason !== undefined &&
        stateReason !== "completed" &&
        stateReason !== "not-planned")
    )
      return yield* Effect.fail(
        adapterError("invalid_input", "tracker item is malformed"),
      )
    const updatedAt = yield* boundedSafeText(
      "updatedAt",
      yield* field(value, "updatedAt"),
      80,
    )
    const labelValues = yield* inputElements(rawLabels, 100)
    const normalizedLabels = yield* Effect.all(
      labelValues.map(label =>
        Effect.map(boundedSafeText("tracker label", label, 256), text =>
          text.toLowerCase(),
        ),
      ),
    )
    const labels = new Set(normalizedLabels)
    if (stateReason !== undefined && (kind !== "issue" || state !== "closed"))
      return yield* Effect.fail(
        adapterError(
          "invalid_input",
          "stateReason applies only to a closed issue",
        ),
      )
    const blockedReason = yield* field(value, "blockedReason")
    if (
      blockedReason !== undefined &&
      (state !== "open" || !labels.has("blocked"))
    )
      return yield* Effect.fail(
        adapterError(
          "invalid_input",
          "blockedReason requires an open blocked item",
        ),
      )
    const requirements = yield* requirementPages(
      yield* field(value, "title"),
      yield* field(value, "body"),
    )
    const canonicalId = `${kind}:${String(number)}`
    const lifecycle = yield* trackerStatus(
      kind,
      state,
      stateReason,
      blockedReason,
      labels,
    )
    const version = yield* digest({
      updatedAt,
      state,
      labels: [...labels].sort(),
      stateReason,
      blockedReason,
      requirements,
    })
    return {
      canonicalId,
      sourceId: `${scopeId}:${canonicalId}:${version}`,
      requirements,
      status: lifecycle.status,
      priority: urgentTrackerItem(labels) ? "urgent" : "normal",
      ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
    }
  })

export const githubTrackerSnapshot = (
  input: GitHubTrackerSnapshotInput,
): Effect.Effect<CanonicalBacklogSnapshot, BacklogSourceAdapterError> =>
  Effect.gen(function* () {
    const project = yield* validProject(yield* field(input, "project"))
    const repository = yield* boundedSafeText(
      "repository",
      yield* field(input, "repository"),
      201,
    )
    if (!SAFE_REPOSITORY.test(repository))
      return yield* Effect.fail(
        adapterError("invalid_input", "repository must be owner/name"),
      )
    const coverage = yield* field(input, "coverage")
    if (coverage !== "partial" && coverage !== "complete")
      return yield* Effect.fail(
        adapterError("invalid_input", "coverage is invalid"),
      )
    const itemValues = yield* inputElements(
      yield* field(input, "items"),
      MAX_ITEMS,
    )
    const observedAt = yield* validObservedAt(yield* field(input, "observedAt"))
    const scopeId = `github:${repository}`
    const items = yield* Effect.all(
      itemValues.map(item => githubTrackerItem(item, scopeId)),
    )
    if (new Set(items.map(item => item.canonicalId)).size !== items.length)
      return yield* Effect.fail(
        adapterError("invalid_input", "tracker snapshot repeats an item"),
      )
    return yield* canonicalSnapshot({
      project,
      source: "tracker-item",
      scopeId,
      coverage,
      observedAt,
      items,
    })
  })

const exactDeclarationKeys = new Set([
  "id",
  "status",
  "priority",
  "requirements",
  "reason",
])

const decodeDocumentDeclaration = (
  value: unknown,
): Effect.Effect<BacklogDocumentDeclaration, BacklogSourceAdapterError> =>
  Effect.gen(function* () {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return yield* Effect.fail(
        adapterError("malformed_declaration", "declaration must be an object"),
      )
    if (Object.keys(value).some(key => !exactDeclarationKeys.has(key)))
      return yield* Effect.fail(
        adapterError(
          "malformed_declaration",
          "declaration contains an unknown field",
        ),
      )
    const id = yield* boundedSafeText(
      "declaration id",
      yield* field(value, "id"),
      128,
    )
    if (!SAFE_IDENTIFIER.test(id) || id.includes("/") || id.includes(":"))
      return yield* Effect.fail(
        adapterError("malformed_declaration", "declaration id is invalid"),
      )
    const status = yield* field(value, "status")
    if (
      status !== "ready" &&
      status !== "blocked" &&
      status !== "completed" &&
      status !== "cancelled"
    )
      return yield* Effect.fail(
        adapterError("malformed_declaration", "declaration status is invalid"),
      )
    const priority = yield* field(value, "priority")
    if (priority !== "normal" && priority !== "urgent")
      return yield* Effect.fail(
        adapterError(
          "malformed_declaration",
          "declaration priority is invalid",
        ),
      )
    const requirementValues = yield* field(value, "requirements")
    if (
      !Array.isArray(requirementValues) ||
      requirementValues.length === 0 ||
      requirementValues.length > MAX_REQUIREMENTS
    )
      return yield* Effect.fail(
        adapterError(
          "malformed_declaration",
          "declaration requirements are invalid",
        ),
      )
    const requirements = yield* Effect.all(
      requirementValues.map(requirement =>
        boundedSafeText(
          "declaration requirement",
          requirement,
          MAX_REQUIREMENT_CHARACTERS,
        ),
      ),
    )
    const reasonValue = yield* field(value, "reason")
    if (status === "blocked") {
      const reason = yield* boundedSafeText(
        "blocked declaration reason",
        reasonValue,
        MAX_REQUIREMENT_CHARACTERS,
      ).pipe(
        Effect.mapError(() =>
          adapterError(
            "malformed_declaration",
            "blocked declaration requires a reason",
          ),
        ),
      )
      return { id, status, priority, requirements, reason }
    }
    if (reasonValue !== undefined)
      return yield* Effect.fail(
        adapterError(
          "malformed_declaration",
          "only a blocked declaration may have a reason",
        ),
      )
    return { id, status, priority, requirements }
  })

const documentDeclarations = (
  content: string,
): Effect.Effect<
  readonly BacklogDocumentDeclaration[],
  BacklogSourceAdapterError
> =>
  Effect.gen(function* () {
    const declarations: BacklogDocumentDeclaration[] = []
    const starts = [...content.matchAll(DOCUMENT_FENCE_START)]
    if (starts.length === 0) return declarations
    const lastStart = starts.at(-1)?.index
    if (lastStart === undefined)
      return yield* Effect.fail(
        adapterError(
          "internal_failure",
          "backlog fence position is unavailable",
        ),
      )
    // Failed suffix searches otherwise repeat for every unmatched opening.
    if (content.lastIndexOf("\n```") <= lastStart)
      return yield* Effect.fail(
        adapterError(
          "malformed_declaration",
          "document contains an unterminated backlog fence",
        ),
      )
    const matches = [...content.matchAll(DOCUMENT_FENCE)]
    if (matches.length !== starts.length)
      return yield* Effect.fail(
        adapterError(
          "malformed_declaration",
          "document contains an unterminated backlog fence",
        ),
      )
    for (const match of matches) {
      const json = match[1]
      if (json === undefined)
        return yield* Effect.fail(
          adapterError("malformed_declaration", "backlog fence is empty"),
        )
      const decoded = yield* Effect.try({
        try: (): unknown => JSON.parse(json),
        catch: () =>
          adapterError(
            "malformed_declaration",
            "backlog fence is not valid JSON",
          ),
      })
      const values = Array.isArray(decoded) ? decoded : [decoded]
      for (const value of values)
        declarations.push(yield* decodeDocumentDeclaration(value))
      if (declarations.length > MAX_ITEMS)
        return yield* Effect.fail(
          adapterError("invalid_input", "document has too many declarations"),
        )
    }
    return declarations
  })

export const backlogDocumentSnapshot = (
  input: BacklogDocumentSnapshotInput,
): Effect.Effect<CanonicalBacklogSnapshot, BacklogSourceAdapterError> =>
  Effect.gen(function* () {
    const project = yield* validProject(yield* field(input, "project"))
    const documentId = yield* boundedSafeText(
      "documentId",
      yield* field(input, "documentId"),
      80,
    )
    if (
      !SAFE_IDENTIFIER.test(documentId) ||
      isAbsolute(documentId) ||
      documentId.split("/").some(segment => segment === "..")
    )
      return yield* Effect.fail(
        adapterError("invalid_input", "documentId is invalid"),
      )
    const content = yield* field(input, "content")
    if (
      typeof content !== "string" ||
      content.length > MAX_DOCUMENT_CHARACTERS ||
      UNSAFE_CONTROL_CHARACTERS.test(content)
    )
      return yield* Effect.fail(
        adapterError("invalid_input", "document content is invalid"),
      )
    const observedAt = yield* validObservedAt(yield* field(input, "observedAt"))
    const scopeId = `document:${documentId}`
    const declarations = yield* documentDeclarations(content)
    if (
      new Set(declarations.map(declaration => declaration.id)).size !==
      declarations.length
    )
      return yield* Effect.fail(
        adapterError(
          "malformed_declaration",
          "document repeats a declaration id",
        ),
      )
    const items = yield* Effect.all(
      declarations.map(declaration =>
        Effect.map(digest(declaration), version => ({
          canonicalId: declaration.id,
          sourceId: `${scopeId}:${declaration.id}:${version}`,
          requirements: declaration.requirements,
          status: declaration.status,
          priority: declaration.priority,
          ...(declaration.reason ? { reason: declaration.reason } : {}),
        })),
      ),
    )
    return yield* canonicalSnapshot({
      project,
      source: "backlog-document",
      scopeId,
      coverage: content.includes(COMPLETE_DOCUMENT_MARKER)
        ? "complete"
        : "partial",
      observedAt,
      items,
    })
  })
