import { createHash } from "node:crypto"
import { isAbsolute, normalize } from "node:path"
import { Data, Effect } from "effect"

export type BacklogSourceKind =
  | "owner-message"
  | "bridge-message"
  | "registry-request"
  | "branch-todo"
  | "tracker-item"
  | "backlog-document"

export type BacklogPriority = "normal" | "urgent"

export type BacklogAuthority =
  | { readonly kind: "routing-only" }
  | { readonly kind: "authenticated-owner"; readonly ref: string }
  | { readonly kind: "repository-policy"; readonly ref: string }

export interface BacklogEvidence {
  readonly kind: string
  readonly ref: string
}

export type BacklogItemState =
  | { readonly kind: "unreconciled" }
  | { readonly kind: "ready" }
  | {
      readonly kind: "assigned"
      readonly agentId: string
      readonly leaseId: string
    }
  | {
      readonly kind: "implementing"
      readonly agentId: string
      readonly leaseId: string
      readonly implementationRef: string
    }
  | {
      readonly kind: "in-review"
      readonly agentId: string
      readonly leaseId: string
      readonly implementationRef: string
      readonly reviewRef: string
    }
  | {
      readonly kind: "publishing"
      readonly agentId: string
      readonly leaseId: string
      readonly implementationRef: string
      readonly reviewRef: string
      readonly publicationRef: string
    }
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "terminal"
      readonly outcome: "completed" | "cancelled"
      readonly evidence: readonly BacklogEvidence[]
    }

export interface BacklogItem {
  readonly id: string
  readonly project: string
  readonly priority: BacklogPriority
  readonly state: BacklogItemState
  readonly dedupeDigest: string
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface BacklogSourceRecord {
  readonly kind: BacklogSourceKind
  readonly id: string
  readonly itemId: string
  readonly authority: BacklogAuthority
  readonly observedAt: number
  readonly contentDigest: string
}

export interface BacklogRequirementRecord {
  readonly id: string
  readonly itemId: string
  readonly sourceKind: BacklogSourceKind
  readonly sourceId: string
  readonly text: string
  readonly digest: string
}

export type BacklogEvidencePhase =
  "implementation" | "review" | "publication" | "terminal"

export interface BacklogEvidenceRecord extends BacklogEvidence {
  readonly id: string
  readonly itemId: string
  readonly phase: BacklogEvidencePhase
  readonly at: number
}

export interface BacklogTransitionRecord {
  readonly itemId: string
  readonly revision: number
  readonly actor: string
  readonly event: BacklogTransitionEvent["kind"]
  readonly from: BacklogItemState["kind"]
  readonly to: BacklogItemState["kind"]
  readonly at: number
}

export interface BacklogState {
  readonly items: readonly BacklogItem[]
  readonly sources: readonly BacklogSourceRecord[]
  readonly requirements: readonly BacklogRequirementRecord[]
  readonly evidence: readonly BacklogEvidenceRecord[]
  readonly transitions: readonly BacklogTransitionRecord[]
}

export const emptyBacklogState: BacklogState = {
  items: [],
  sources: [],
  requirements: [],
  evidence: [],
  transitions: [],
}

export interface IngestBacklogSourceInput {
  readonly newItemId: string
  readonly project: string
  readonly source: { readonly kind: BacklogSourceKind; readonly id: string }
  readonly observedAt: number
  readonly priority: BacklogPriority
  readonly requirements: readonly { readonly text: string }[]
  readonly authority: BacklogAuthority
  readonly dedupe:
    | {
        readonly kind: "exact-content" | "source-only"
        readonly scope?: string
      }
    | {
        readonly kind: "canonical-key"
        readonly key: string
      }
    | {
        readonly kind: "item-id"
        readonly itemId: string
      }
  readonly initialState: "ready" | "unreconciled"
}

export interface IngestBacklogSourceResult {
  readonly state: BacklogState
  readonly item: BacklogItem
  readonly created: boolean
}

export type BacklogTransitionEvent =
  | {
      readonly kind: "assign"
      readonly agentId: string
      readonly leaseId: string
    }
  | { readonly kind: "start"; readonly implementationRef: string }
  | { readonly kind: "review"; readonly reviewRef: string }
  | { readonly kind: "publish"; readonly publicationRef: string }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "ready" }
  | { readonly kind: "complete"; readonly evidence: readonly BacklogEvidence[] }
  | {
      readonly kind: "reconcile"
      readonly outcome: "completed" | "cancelled"
      readonly evidence: readonly BacklogEvidence[]
    }
  | { readonly kind: "cancel"; readonly evidence: readonly BacklogEvidence[] }

export interface TransitionBacklogItemInput {
  readonly itemId: string
  readonly expectedRevision: number
  readonly actor: string
  readonly now: number
  readonly event: BacklogTransitionEvent
}

export interface TransitionBacklogItemResult {
  readonly state: BacklogState
  readonly item: BacklogItem
}

export interface BacklogProjection {
  readonly actionable: number
  readonly blocked: number
  readonly unreconciled: number
  readonly totalOpen: number
}

export interface BacklogStore<StoreError = BacklogError> {
  readonly backlogProjects: () => Effect.Effect<readonly string[], StoreError>
  readonly backlogSnapshot: (
    project: string,
  ) => Effect.Effect<BacklogState, StoreError>
}

export class BacklogError extends Data.TaggedError("BacklogError")<{
  readonly code:
    | "internal_failure"
    | "invalid_input"
    | "invalid_transition"
    | "missing_evidence"
    | "not_found"
    | "source_conflict"
    | "stale_revision"
  readonly message: string
}> {}

const MAX_ID_CHARACTERS = 256
const MAX_REQUIREMENTS = 32
const MAX_REQUIREMENT_CHARACTERS = 4_000
const MAX_EVIDENCE = 32
const MAX_EVIDENCE_REF_CHARACTERS = 1_024
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

const error = (code: BacklogError["code"], message: string): BacklogError =>
  new BacklogError({ code, message })

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined

const boundedText = (
  label: string,
  value: unknown,
  maximum: number,
): Effect.Effect<string, BacklogError> => {
  if (typeof value !== "string")
    return Effect.fail(error("invalid_input", `${label} is not text`))
  const text = value.trim()
  return text.length === 0 ||
    text.length > maximum ||
    UNSAFE_CONTROL_CHARACTERS.test(text)
    ? Effect.fail(error("invalid_input", `${label} is not bounded safe text`))
    : Effect.succeed(text)
}

const identifier = (
  label: string,
  value: unknown,
): Effect.Effect<string, BacklogError> =>
  Effect.flatMap(boundedText(label, value, MAX_ID_CHARACTERS), text =>
    /^[A-Za-z0-9._:/-]+$/u.test(text)
      ? Effect.succeed(text)
      : Effect.fail(error("invalid_input", `${label} has invalid characters`)),
  )

const timestamp = (
  label: string,
  value: unknown,
): Effect.Effect<number, BacklogError> =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_input", `${label} must be a timestamp`))

const projectPath = (value: unknown): Effect.Effect<string, BacklogError> =>
  Effect.flatMap(boundedText("project", value, 1_024), text => {
    const project = normalize(text)
    return isAbsolute(project)
      ? Effect.succeed(project)
      : Effect.fail(error("invalid_input", "project must be an absolute path"))
  })

const digest = (value: string): Effect.Effect<string, BacklogError> =>
  Effect.try({
    try: () => createHash("sha256").update(value).digest("hex"),
    catch: () => error("internal_failure", "backlog digest failed"),
  })

const normalizedRequirement = (
  value: unknown,
): Effect.Effect<string, BacklogError> =>
  Effect.map(
    boundedText("requirement", value, MAX_REQUIREMENT_CHARACTERS),
    text => text.replace(/\s+/gu, " "),
  )

const validatedSourceKind = (
  value: unknown,
): Effect.Effect<BacklogSourceKind, BacklogError> =>
  value === "owner-message" ||
  value === "bridge-message" ||
  value === "registry-request" ||
  value === "branch-todo" ||
  value === "tracker-item" ||
  value === "backlog-document"
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_input", "backlog source kind is malformed"))

const validatedPriority = (
  value: unknown,
): Effect.Effect<BacklogPriority, BacklogError> =>
  value === "normal" || value === "urgent"
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_input", "backlog priority is malformed"))

const validatedInitialState = (
  value: unknown,
): Effect.Effect<IngestBacklogSourceInput["initialState"], BacklogError> =>
  value === "ready" || value === "unreconciled"
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_input", "backlog initial state is malformed"))

const validatedEventKind = (
  value: unknown,
): Effect.Effect<BacklogTransitionEvent["kind"], BacklogError> =>
  value === "assign" ||
  value === "start" ||
  value === "review" ||
  value === "publish" ||
  value === "block" ||
  value === "ready" ||
  value === "complete" ||
  value === "reconcile" ||
  value === "cancel"
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_input", "backlog event is malformed"))

const validatedAuthority = (
  authority: unknown,
): Effect.Effect<BacklogAuthority, BacklogError> => {
  const kind = field(authority, "kind")
  if (kind === "routing-only") return Effect.succeed({ kind })
  if (kind !== "authenticated-owner" && kind !== "repository-policy")
    return Effect.fail(error("invalid_input", "backlog authority is malformed"))
  return Effect.map(
    identifier("authority reference", field(authority, "ref")),
    ref => ({
      kind,
      ref,
    }),
  )
}

const validatedDedupe = (
  dedupe: unknown,
): Effect.Effect<IngestBacklogSourceInput["dedupe"], BacklogError> => {
  const kind = field(dedupe, "kind")
  if (kind === "exact-content" || kind === "source-only") {
    const scope = field(dedupe, "scope")
    return scope === undefined
      ? Effect.succeed({ kind })
      : Effect.map(identifier("dedupe scope", scope), validated => ({
          kind,
          scope: validated,
        }))
  }
  if (kind === "canonical-key")
    return Effect.map(
      identifier("canonical key", field(dedupe, "key")),
      key => ({
        kind,
        key,
      }),
    )
  if (kind === "item-id")
    return Effect.map(
      identifier("dedupe item ID", field(dedupe, "itemId")),
      itemId => ({
        kind,
        itemId,
      }),
    )
  return Effect.fail(error("invalid_input", "backlog dedupe kind is malformed"))
}

const validatedEvidence = (
  evidence: unknown,
): Effect.Effect<readonly BacklogEvidence[], BacklogError> => {
  if (!Array.isArray(evidence) || evidence.length === 0)
    return Effect.fail(
      error("missing_evidence", "terminal work requires evidence"),
    )
  if (evidence.length > MAX_EVIDENCE)
    return Effect.fail(error("invalid_input", "too many evidence records"))
  return Effect.all(
    evidence.map(record =>
      Effect.gen(function* () {
        const kind = yield* identifier("evidence kind", field(record, "kind"))
        const ref = yield* boundedText(
          "evidence reference",
          field(record, "ref"),
          MAX_EVIDENCE_REF_CHARACTERS,
        )
        return { kind, ref }
      }),
    ),
  )
}

const openItem = (item: BacklogItem): boolean => item.state.kind !== "terminal"

export const ingestBacklogSource = (
  state: BacklogState,
  input: IngestBacklogSourceInput,
): Effect.Effect<IngestBacklogSourceResult, BacklogError> =>
  Effect.gen(function* () {
    const project = yield* projectPath(field(input, "project"))
    const newItemId = yield* identifier("item ID", field(input, "newItemId"))
    const sourceValue = field(input, "source")
    const sourceKind = yield* validatedSourceKind(field(sourceValue, "kind"))
    const sourceId = yield* identifier("source ID", field(sourceValue, "id"))
    const observedAt = yield* timestamp(
      "observedAt",
      field(input, "observedAt"),
    )
    const priority = yield* validatedPriority(field(input, "priority"))
    const initialState = yield* validatedInitialState(
      field(input, "initialState"),
    )
    const authority = yield* validatedAuthority(field(input, "authority"))
    const dedupe = yield* validatedDedupe(field(input, "dedupe"))
    const requirementValues = field(input, "requirements")
    if (!Array.isArray(requirementValues) || requirementValues.length === 0)
      return yield* Effect.fail(
        error("invalid_input", "at least one requirement is required"),
      )
    if (requirementValues.length > MAX_REQUIREMENTS)
      return yield* Effect.fail(error("invalid_input", "too many requirements"))
    const requirements = yield* Effect.all(
      requirementValues.map(value =>
        normalizedRequirement(field(value, "text")),
      ),
    )
    const contentDigest = yield* digest(requirements.join("\u001f"))
    const existingSource = state.sources.find(
      source => source.kind === sourceKind && source.id === sourceId,
    )
    if (existingSource) {
      const item = state.items.find(({ id }) => id === existingSource.itemId)
      if (!item)
        return yield* Effect.fail(error("not_found", "source item is missing"))
      if (item.project !== project)
        return yield* Effect.fail(
          error(
            "source_conflict",
            "source identity belongs to another project",
          ),
        )
      if (existingSource.contentDigest !== contentDigest)
        return yield* Effect.fail(
          error(
            "source_conflict",
            "source identity was reused with different content",
          ),
        )
      return { state, item, created: false }
    }

    const dedupeDigest = yield* Effect.gen(function* () {
      if (dedupe.kind === "canonical-key")
        return yield* digest(`canonical\u001f${dedupe.key}`)
      if (dedupe.kind === "item-id") {
        const existing = state.items.find(
          item => item.id === dedupe.itemId && item.project === project,
        )
        return existing
          ? existing.dedupeDigest
          : yield* Effect.fail(error("not_found", "dedupe item is missing"))
      }
      return yield* digest(
        dedupe.kind === "exact-content"
          ? `${dedupe.scope ?? ""}\u001f${contentDigest}`
          : `${sourceKind}:${sourceId}`,
      )
    })
    const matchingItem =
      dedupe.kind === "item-id"
        ? state.items.find(item => item.id === dedupe.itemId)
        : state.items.find(
            item =>
              item.project === project &&
              openItem(item) &&
              (item.dedupeDigest === dedupeDigest ||
                (dedupe.kind === "canonical-key" &&
                  state.sources.some(
                    source =>
                      source.itemId === item.id &&
                      source.contentDigest === contentDigest,
                  ))),
          )
    const created = matchingItem === undefined
    const item: BacklogItem = matchingItem ?? {
      id: newItemId,
      project,
      priority,
      state: { kind: initialState },
      dedupeDigest,
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
    }
    const updatedItem: BacklogItem = matchingItem
      ? {
          ...matchingItem,
          priority:
            matchingItem.priority === "urgent" || priority === "urgent"
              ? "urgent"
              : "normal",
          revision: matchingItem.revision + 1,
          updatedAt: Math.max(matchingItem.updatedAt, observedAt),
        }
      : item
    const source: BacklogSourceRecord = {
      kind: sourceKind,
      id: sourceId,
      itemId: updatedItem.id,
      authority,
      observedAt,
      contentDigest,
    }
    const requirementRecords = yield* Effect.all(
      requirements.map((text, index) =>
        Effect.map(digest(text), requirementDigest => ({
          id: `${sourceKind}:${sourceId}:${index}`,
          itemId: updatedItem.id,
          sourceKind,
          sourceId,
          text,
          digest: requirementDigest,
        })),
      ),
    )
    return {
      state: {
        items: created
          ? [...state.items, updatedItem]
          : state.items.map(current =>
              current.id === updatedItem.id ? updatedItem : current,
            ),
        sources: [...state.sources, source],
        requirements: [...state.requirements, ...requirementRecords],
        evidence: state.evidence,
        transitions: state.transitions,
      },
      item: updatedItem,
      created,
    }
  })

const activeAssignment = (
  state: BacklogItemState,
): { readonly agentId: string; readonly leaseId: string } | undefined => {
  switch (state.kind) {
    case "assigned":
    case "implementing":
    case "in-review":
    case "publishing":
      return { agentId: state.agentId, leaseId: state.leaseId }
    default:
      return undefined
  }
}

const evidenceRef = (
  label: string,
  value: unknown,
): Effect.Effect<string, BacklogError> =>
  boundedText(label, value, MAX_EVIDENCE_REF_CHARACTERS)

const transitionEvidence = (
  itemId: string,
  revision: number,
  now: number,
  event: BacklogTransitionEvent,
): Effect.Effect<readonly BacklogEvidenceRecord[], BacklogError> => {
  const record = (
    phase: BacklogEvidencePhase,
    kind: string,
    ref: string,
    index = 0,
  ): BacklogEvidenceRecord => ({
    id: `${itemId}:${revision}:${phase}:${index}`,
    itemId,
    phase,
    kind,
    ref,
    at: now,
  })
  switch (field(event, "kind")) {
    case "start":
      return Effect.map(
        evidenceRef(
          "implementation reference",
          field(event, "implementationRef"),
        ),
        ref => [record("implementation", "implementation-reference", ref)],
      )
    case "review":
      return Effect.map(
        evidenceRef("review reference", field(event, "reviewRef")),
        ref => [record("review", "review-reference", ref)],
      )
    case "publish":
      return Effect.map(
        evidenceRef("publication reference", field(event, "publicationRef")),
        ref => [record("publication", "publication-reference", ref)],
      )
    case "complete":
    case "reconcile":
    case "cancel":
      return Effect.map(validatedEvidence(field(event, "evidence")), evidence =>
        evidence.map((entry, index) =>
          record("terminal", entry.kind, entry.ref, index),
        ),
      )
    case "assign":
    case "block":
    case "ready":
      return Effect.succeed([])
    default:
      return Effect.fail(error("invalid_input", "backlog event is malformed"))
  }
}

const nextState = (
  current: BacklogItemState,
  event: BacklogTransitionEvent,
): Effect.Effect<BacklogItemState, BacklogError> =>
  Effect.gen(function* () {
    if (current.kind === "terminal")
      return yield* Effect.fail(
        error("invalid_transition", "terminal work cannot transition"),
      )
    switch (field(event, "kind")) {
      case "assign":
        if (current.kind !== "ready")
          return yield* Effect.fail(
            error("invalid_transition", "only ready work can be assigned"),
          )
        return {
          kind: "assigned",
          agentId: yield* identifier("agent ID", field(event, "agentId")),
          leaseId: yield* identifier("lease ID", field(event, "leaseId")),
        }
      case "start": {
        const assignment = activeAssignment(current)
        if (current.kind !== "assigned" || !assignment)
          return yield* Effect.fail(
            error("invalid_transition", "only assigned work can start"),
          )
        return {
          kind: "implementing",
          ...assignment,
          implementationRef: yield* evidenceRef(
            "implementation reference",
            field(event, "implementationRef"),
          ),
        }
      }
      case "review": {
        const assignment = activeAssignment(current)
        if (current.kind !== "implementing" || !assignment)
          return yield* Effect.fail(
            error("invalid_transition", "only implementing work can review"),
          )
        return {
          kind: "in-review",
          ...assignment,
          implementationRef: current.implementationRef,
          reviewRef: yield* evidenceRef(
            "review reference",
            field(event, "reviewRef"),
          ),
        }
      }
      case "publish": {
        const assignment = activeAssignment(current)
        if (current.kind !== "in-review" || !assignment)
          return yield* Effect.fail(
            error("invalid_transition", "only reviewed work can publish"),
          )
        return {
          kind: "publishing",
          ...assignment,
          implementationRef: current.implementationRef,
          reviewRef: current.reviewRef,
          publicationRef: yield* evidenceRef(
            "publication reference",
            field(event, "publicationRef"),
          ),
        }
      }
      case "block":
        return {
          kind: "blocked",
          reason: yield* boundedText(
            "block reason",
            field(event, "reason"),
            2_000,
          ),
        }
      case "ready":
        return current.kind === "blocked" || current.kind === "unreconciled"
          ? { kind: "ready" }
          : yield* Effect.fail(
              error(
                "invalid_transition",
                "only blocked or unreconciled work can become ready",
              ),
            )
      case "complete":
        if (
          current.kind !== "implementing" &&
          current.kind !== "in-review" &&
          current.kind !== "publishing"
        )
          return yield* Effect.fail(
            error("invalid_transition", "only implemented work can complete"),
          )
        return {
          kind: "terminal",
          outcome: "completed",
          evidence: yield* validatedEvidence(field(event, "evidence")),
        }
      case "reconcile": {
        const outcome = field(event, "outcome")
        if (outcome !== "completed" && outcome !== "cancelled")
          return yield* Effect.fail(
            error("invalid_input", "reconciliation outcome is malformed"),
          )
        return {
          kind: "terminal",
          outcome,
          evidence: yield* validatedEvidence(field(event, "evidence")),
        }
      }
      case "cancel":
        return {
          kind: "terminal",
          outcome: "cancelled",
          evidence: yield* validatedEvidence(field(event, "evidence")),
        }
      default:
        return yield* Effect.fail(
          error("invalid_input", "backlog event is malformed"),
        )
    }
  })

export const transitionBacklogItem = (
  state: BacklogState,
  input: TransitionBacklogItemInput,
): Effect.Effect<TransitionBacklogItemResult, BacklogError> =>
  Effect.gen(function* () {
    const itemId = yield* identifier("item ID", field(input, "itemId"))
    const actor = yield* identifier("actor", field(input, "actor"))
    const now = yield* timestamp("now", field(input, "now"))
    const expectedRevision = field(input, "expectedRevision")
    const item = state.items.find(current => current.id === itemId)
    if (!item)
      return yield* Effect.fail(error("not_found", "backlog item not found"))
    if (item.revision !== expectedRevision)
      return yield* Effect.fail(
        error("stale_revision", "backlog item revision changed"),
      )
    const eventKind = yield* validatedEventKind(field(input.event, "kind"))
    const updated: BacklogItem = {
      ...item,
      state: yield* nextState(item.state, input.event),
      revision: item.revision + 1,
      updatedAt: now,
    }
    const evidence = yield* transitionEvidence(
      item.id,
      updated.revision,
      now,
      input.event,
    )
    const transition: BacklogTransitionRecord = {
      itemId,
      revision: updated.revision,
      actor,
      event: eventKind,
      from: item.state.kind,
      to: updated.state.kind,
      at: now,
    }
    return {
      state: {
        ...state,
        items: state.items.map(current =>
          current.id === itemId ? updated : current,
        ),
        evidence: [...state.evidence, ...evidence],
        transitions: [...state.transitions, transition],
      },
      item: updated,
    }
  })

const projectBacklogProjection = (
  state: BacklogState,
  project: string,
  include: (item: BacklogItem) => boolean,
): Effect.Effect<BacklogProjection, BacklogError> =>
  Effect.map(projectPath(project), canonicalProject => {
    const open = state.items.filter(
      item =>
        item.project === canonicalProject && openItem(item) && include(item),
    )
    return {
      actionable: open.filter(item =>
        [
          "ready",
          "assigned",
          "implementing",
          "in-review",
          "publishing",
        ].includes(item.state.kind),
      ).length,
      blocked: open.filter(item => item.state.kind === "blocked").length,
      unreconciled: open.filter(item => item.state.kind === "unreconciled")
        .length,
      totalOpen: open.length,
    }
  })

export const backlogProjection = (
  state: BacklogState,
  project: string,
): Effect.Effect<BacklogProjection, BacklogError> =>
  projectBacklogProjection(state, project, () => true)

export const externalBacklogProjection = (
  state: BacklogState,
  project: string,
): Effect.Effect<BacklogProjection, BacklogError> => {
  const externalItemIds = new Set(
    state.sources
      .filter(source => source.kind !== "branch-todo")
      .map(source => source.itemId),
  )
  return projectBacklogProjection(state, project, item =>
    externalItemIds.has(item.id),
  )
}
