import { chmodSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { Effect, Either } from "effect"
import {
  BacklogError,
  ingestBacklogSource,
  transitionBacklogItem,
  type BacklogAuthority,
  type BacklogEvidencePhase,
  type BacklogEvidenceRecord,
  type BacklogItem,
  type BacklogItemState,
  type BacklogRequirementRecord,
  type BacklogSourceKind,
  type BacklogSourceRecord,
  type BacklogState,
  type BacklogStore,
  type BacklogTransitionRecord,
  type IngestBacklogSourceResult,
} from "./backlog.ts"
import type {
  BranchTodoBacklogSnapshot,
  CanonicalBacklogSnapshot,
  MessageBacklogRecord,
} from "../shared/backlog-events.ts"
import type { AgentTokenUsage } from "./usage.ts"
import { parseRuntimeAgentId, sameRuntimeSession } from "./runtime-identity.ts"
import {
  RegistryError,
  type AcknowledgeRequestInput,
  type AdvanceRequestBacklogInput,
  type AgentActivity,
  type AgentHeartbeatInput,
  type AgentIdentity,
  type CancelRequestInput,
  type ClearExceptProjectInput,
  type ClearedRegistryCounts,
  type ClaimLeaseInput,
  type ClaimLeaseResult,
  type ClaimRequestInput,
  type CompleteRequestInput,
  type EnqueueRequestInput,
  type FailRequestInput,
  type HeartbeatInput,
  type Lease,
  type PauseLeaseInput,
  type ReceiveRequestInput,
  type RegisteredAgent,
  type RegistryRequest,
  type RegistryRequestPriority,
  type RegistrySnapshot,
  type RegistryStore,
  type ReleaseLeaseInput,
} from "./registry.ts"

export interface SqliteRegistryStore
  extends RegistryStore, BacklogStore<RegistryError> {
  readonly reconcileBranchTodos: (
    snapshot: BranchTodoBacklogSnapshot,
  ) => Effect.Effect<BacklogState, RegistryError>
  readonly ingestMessage: (
    message: MessageBacklogRecord,
  ) => Effect.Effect<BacklogState, RegistryError>
  readonly reconcileCanonicalBacklog: (
    snapshot: CanonicalBacklogSnapshot,
  ) => Effect.Effect<BacklogState, RegistryError>
  readonly close: () => void
}

// Source identity, cumulative token usage, and the shadow backlog ledger are
// additive so sessions still running the prior adapter can coexist during
// rolling Pi reloads.
const SCHEMA_VERSION = 5
const MAX_LEASES = 1_024
const MAX_REQUESTS = 10_000
const MAX_BACKLOG_PROJECTS = 1_024
const MAX_REQUEST_TEXT = 8_000
const MAX_SUMMARY_TEXT = 4_000
const MAX_AGENT_ACTIVITIES = 3
const MAX_AGENT_ACTIVITY_TEXT = 512
const BUSY_TIMEOUT_MS = 2_000
const SENSITIVE_TEXT =
  /(^|[\\/\s'"])(?:\.env(?:\.[^\\/\s'"]*)?|credentials\.json|secrets\.(?:json|ya?ml)|auth\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/\s'"]+\.(?:key|pem|p12|pfx))($|[\\/\s'"])/i
const SQL_JSONPATH_DOT_QUOTED_KEY = /\."(?:[^"\\]|\\.)*"/g
const containsSensitiveText = (text: string): boolean =>
  SENSITIVE_TEXT.test(text.replace(SQL_JSONPATH_DOT_QUOTED_KEY, "$.[json-key]"))

type Row = Readonly<Record<string, unknown>>

const rowFrom = (value: unknown): RegistryEffect<Row> => rowEffect(value)

const optionalRowFrom = (value: unknown): RegistryEffect<Row | undefined> =>
  optionalRowEffect(value)

const rowsFrom = (value: unknown): RegistryEffect<readonly Row[]> =>
  rowsEffect(value)

const registryError: (
  code: RegistryError["code"],
  message: string,
) => RegistryError = (code, message) => new RegistryError({ code, message })

const asRegistryError: (error: unknown, fallback: string) => RegistryError = (
  error,
  fallback,
) => {
  if (error instanceof RegistryError) return error
  const message = error instanceof Error ? error.message : ""
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : ""
  const busy = /busy|locked/i.test(message) || /BUSY|LOCKED/i.test(code)
  const knownCause = [
    /database is (?:busy|locked)/i,
    /disk I\/O error/i,
    /database disk image is malformed/i,
    /unable to open database file/i,
    /readonly database/i,
  ].find(pattern => pattern.test(message))
  const cause = knownCause
    ? message.match(knownCause)?.[0]
    : code && /^ERR_SQLITE_[A-Z_]+$/.test(code)
      ? code
      : undefined
  return registryError(
    busy ? "busy" : "io",
    cause ? `${fallback}: ${cause}` : fallback,
  )
}

type RegistryEffect<T> = Effect.Effect<T, RegistryError>

const failRegistry = (
  code: RegistryError["code"],
  message: string,
): RegistryEffect<never> => Effect.fail(registryError(code, message))

const dbCall = <T>(label: string, operation: () => T): RegistryEffect<T> =>
  Effect.try({
    try: operation,
    catch: error => asRegistryError(error, label),
  })

const rollbackAndFail = <T>(
  database: DatabaseSync,
  error: RegistryError,
): RegistryEffect<T> =>
  dbCall("Could not roll back registry transaction", () =>
    database.exec("ROLLBACK"),
  ).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.andThen(Effect.fail(error)),
  )

const transactionEffect = <T>(
  database: DatabaseSync,
  work: RegistryEffect<T>,
): RegistryEffect<T> =>
  dbCall("Could not begin registry transaction", () =>
    database.exec("BEGIN IMMEDIATE"),
  ).pipe(
    Effect.flatMap(() =>
      work.pipe(
        Effect.flatMap(result =>
          dbCall("Could not commit registry transaction", () =>
            database.exec("COMMIT"),
          ).pipe(Effect.as(result)),
        ),
        Effect.catchAll(error => rollbackAndFail(database, error)),
      ),
    ),
  )

const hasUnsafeControlCharacters: (text: string) => boolean = text =>
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)

const boundedText = (
  label: string,
  text: string,
  maximum: number,
): RegistryEffect<string> => boundedTextEffect(label, text, maximum)

const persistedText = (
  label: string,
  text: string,
  maximum: number,
): RegistryEffect<string> => persistedTextEffect(label, text, maximum)

const canonicalProject = (project: string): RegistryEffect<string> =>
  canonicalProjectEffect(project)

const roleName = (role: string): RegistryEffect<string> => roleNameEffect(role)

const isWithinProject: (candidate: string, project: string) => boolean = (
  candidate,
  project,
) => {
  const path = relative(project, candidate)
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  )
}

const validateRuntimeVersions = (
  runtimeVersions: Readonly<Record<string, string>> | undefined,
): RegistryEffect<Readonly<Record<string, string>> | undefined> =>
  validateRuntimeVersionsEffect(runtimeVersions)

const validateAgent = (agent: AgentIdentity): RegistryEffect<AgentIdentity> =>
  validateAgentEffect(agent)

const migrateLegacyRuntimeIdentity = (
  database: DatabaseSync,
  identity: AgentIdentity,
): RegistryEffect<void> =>
  migrateLegacyRuntimeIdentityEffect(database, identity)

const validateTokenUsage = (
  usage: AgentTokenUsage,
): RegistryEffect<AgentTokenUsage> => validateTokenUsageEffect(usage)

const validateActivities = (
  activities: readonly AgentActivity[] | undefined,
): RegistryEffect<readonly AgentActivity[]> =>
  validateActivitiesEffect(activities)

const requestPriority = (
  value: unknown,
  failure: "invalid_input" | "corrupt_state" = "corrupt_state",
): RegistryEffect<RegistryRequestPriority> =>
  requestPriorityEffect(value, failure)

const validateTime = (label: string, value: number): RegistryEffect<number> =>
  validateTimeEffect(label, value)

const validateTtl = (ttlMs: number): RegistryEffect<number> =>
  validateTtlEffect(ttlMs)

const expiresAt = (now: number, ttlMs: number): RegistryEffect<number> =>
  expiresAtEffect(now, ttlMs)

const stringField = (
  row: Row,
  key: string,
  optional = false,
): RegistryEffect<string | undefined> =>
  optional ? optionalStringField(row, key) : requiredStringField(row, key)

const numberField = (row: Row, key: string): RegistryEffect<number> =>
  requiredNumberField(row, key)

const optionalNumberField = (
  row: Row,
  key: string,
): RegistryEffect<number | undefined> => optionalNumberFieldEffect(row, key)

const runtimeVersionsFromRow = (
  row: Row,
): RegistryEffect<Readonly<Record<string, string>> | undefined> =>
  runtimeVersionsRowEffect(row)

const leaseFromRow = (row: Row): RegistryEffect<Lease> => leaseRowEffect(row)

const activitiesFromRow = (
  row: Row,
): RegistryEffect<readonly AgentActivity[]> => activitiesRowEffect(row)

const registeredAgentFromRow = (row: Row): RegistryEffect<RegisteredAgent> =>
  registeredAgentRowEffect(row)

const requestFromRow = (row: Row): RegistryEffect<RegistryRequest> =>
  requestRowEffect(row)

const rowEffect = (value: unknown): RegistryEffect<Row> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Effect.succeed(value)
    : failRegistry("corrupt_state", "registry query returned a malformed row")

const optionalRowEffect = (value: unknown): RegistryEffect<Row | undefined> =>
  value === undefined ? Effect.succeed(undefined) : rowEffect(value)

const rowsEffect = (value: unknown): RegistryEffect<readonly Row[]> =>
  Array.isArray(value)
    ? Effect.forEach(value, rowEffect)
    : failRegistry("corrupt_state", "registry query returned malformed rows")

const requiredStringField = (row: Row, key: string): RegistryEffect<string> =>
  typeof row[key] === "string"
    ? Effect.succeed(row[key])
    : failRegistry("corrupt_state", `registry column ${key} is malformed`)

const persistedStringField = (
  row: Row,
  key: string,
  maximum: number,
): RegistryEffect<string> =>
  requiredStringField(row, key).pipe(
    Effect.flatMap(value =>
      value.length > 0 &&
      value.length <= maximum &&
      !hasUnsafeControlCharacters(value)
        ? Effect.succeed(value)
        : failRegistry(
            "corrupt_state",
            `registry column ${key} violates its persisted bound`,
          ),
    ),
  )

const optionalStringField = (
  row: Row,
  key: string,
): RegistryEffect<string | undefined> => {
  const value = row[key]
  return value === null
    ? Effect.succeed(undefined)
    : typeof value === "string"
      ? Effect.succeed(value)
      : failRegistry("corrupt_state", `registry column ${key} is malformed`)
}

const requiredNumberField = (row: Row, key: string): RegistryEffect<number> => {
  const value = row[key]
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Effect.succeed(value)
    : failRegistry("corrupt_state", `registry column ${key} is malformed`)
}

const canonicalProjectEffect = (project: string): RegistryEffect<string> => {
  const trimmed = project.trim()
  return isAbsolute(trimmed) &&
    trimmed.length <= 1_024 &&
    !hasUnsafeControlCharacters(trimmed)
    ? Effect.succeed(normalize(trimmed).replace(/\/$/, "") || "/")
    : failRegistry("invalid_input", "project must be a bounded absolute path")
}

const boundedTextEffect = (
  label: string,
  text: string,
  maximum: number,
): RegistryEffect<string> => {
  const trimmed = text.trim()
  return trimmed.length > 0 &&
    trimmed.length <= maximum &&
    !hasUnsafeControlCharacters(trimmed)
    ? Effect.succeed(trimmed)
    : failRegistry(
        "invalid_input",
        `${label} must contain 1-${maximum} safe characters`,
      )
}

const persistedTextEffect = (
  label: string,
  text: string,
  maximum: number,
): RegistryEffect<string> =>
  boundedTextEffect(label, text, maximum).pipe(
    Effect.flatMap(bounded =>
      containsSensitiveText(bounded)
        ? failRegistry(
            "invalid_input",
            `${label} contains a protected credential-shaped path`,
          )
        : Effect.succeed(bounded),
    ),
  )

const roleNameEffect = (role: string): RegistryEffect<string> => {
  const normalized = role.trim()
  return /^[a-z][a-z0-9-]{0,63}$/.test(normalized)
    ? Effect.succeed(normalized)
    : failRegistry("invalid_input", "role must match [a-z][a-z0-9-]{0,63}")
}

const leaseModeEffect = (value: unknown): RegistryEffect<Lease["mode"]> =>
  value === "task" || value === "operational"
    ? Effect.succeed(value)
    : failRegistry("invalid_input", "registry lease mode is malformed")

const requestPriorityEffect = (
  value: unknown,
  code: "invalid_input" | "corrupt_state" = "corrupt_state",
): RegistryEffect<RegistryRequestPriority> =>
  value === "normal" || value === "urgent"
    ? Effect.succeed(value)
    : failRegistry(code, "registry request priority is malformed")

const requestFailureEffect = (
  value: unknown,
): RegistryEffect<FailRequestInput["failure"]> =>
  value === "blocked" ||
  value === "cancelled" ||
  value === "error" ||
  value === "timed_out"
    ? Effect.succeed(value)
    : failRegistry("invalid_input", "registry request failure is malformed")

const validateTimeEffect = (
  label: string,
  value: number,
): RegistryEffect<number> =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : failRegistry("invalid_input", `${label} must be a timestamp`)

const validateTtlEffect = (ttlMs: number): RegistryEffect<number> =>
  Number.isSafeInteger(ttlMs) && ttlMs >= 1 && ttlMs <= 24 * 60 * 60 * 1_000
    ? Effect.succeed(ttlMs)
    : failRegistry("invalid_input", "ttlMs must be between 1ms and 24h")

const expiresAtEffect = (
  now: number,
  ttlMs: number,
): RegistryEffect<number> => {
  const expiration = now + ttlMs
  return Number.isSafeInteger(expiration)
    ? Effect.succeed(expiration)
    : failRegistry("invalid_input", "lease expiration exceeds safe time range")
}

const isRecordValue = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateRuntimeVersionsEffect = (
  runtimeVersions: unknown,
): RegistryEffect<Readonly<Record<string, string>> | undefined> =>
  Effect.gen(function* () {
    if (runtimeVersions === undefined) return undefined
    if (!isRecordValue(runtimeVersions))
      return yield* failRegistry(
        "invalid_input",
        "runtime versions are malformed",
      )
    const entries = Object.entries(runtimeVersions)
    if (entries.some(([, version]) => typeof version !== "string"))
      return yield* failRegistry(
        "invalid_input",
        "runtime versions are malformed",
      )
    if (entries.length > 32)
      return yield* failRegistry(
        "invalid_input",
        "runtime versions exceed component limit",
      )
    const validated = yield* Effect.forEach(entries, ([component, version]) =>
      Effect.all([
        boundedTextEffect("runtime component", component, 64),
        boundedTextEffect("runtime version", version, 128),
      ]).pipe(Effect.map(([name, observed]) => [name, observed] as const)),
    )
    return Object.fromEntries(
      validated.sort(([left], [right]) => left.localeCompare(right)),
    )
  })

const validateAgentEffect = (agent: unknown): RegistryEffect<AgentIdentity> =>
  Effect.gen(function* () {
    if (
      !isRecordValue(agent) ||
      typeof agent.id !== "string" ||
      typeof agent.pid !== "number" ||
      (agent.model !== undefined && typeof agent.model !== "string")
    )
      return yield* failRegistry("invalid_input", "agent identity is malformed")
    const id = yield* boundedTextEffect("agent id", agent.id, 128)
    if (!Number.isSafeInteger(agent.pid) || agent.pid < 1)
      return yield* failRegistry("invalid_input", "pid must be positive")
    const model = agent.model
      ? yield* boundedTextEffect("model", agent.model, 256)
      : undefined
    const runtimeVersions = yield* validateRuntimeVersionsEffect(
      agent.runtimeVersions,
    )
    return {
      id,
      pid: agent.pid,
      ...(model ? { model } : {}),
      ...(runtimeVersions ? { runtimeVersions } : {}),
    }
  })

const validateTokenUsageEffect = (
  usage: unknown,
): RegistryEffect<AgentTokenUsage> => {
  if (!isRecordValue(usage))
    return failRegistry("invalid_input", "agent token usage is malformed")
  const keys = ["cacheRead", "cacheWrite", "input", "output", "totalTokens"]
  const { input, output, cacheRead, cacheWrite, totalTokens } = usage
  if (
    Object.keys(usage).toSorted().join("\u001f") !== keys.join("\u001f") ||
    typeof input !== "number" ||
    typeof output !== "number" ||
    typeof cacheRead !== "number" ||
    typeof cacheWrite !== "number" ||
    typeof totalTokens !== "number" ||
    ![input, output, cacheRead, cacheWrite, totalTokens].every(
      value => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return failRegistry("invalid_input", "agent token usage is malformed")
  return Effect.succeed({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
  })
}

const validateActivitiesEffect = (
  activities: unknown,
): RegistryEffect<readonly AgentActivity[]> =>
  Effect.gen(function* () {
    if (activities === undefined) return []
    if (!Array.isArray(activities))
      return yield* failRegistry(
        "invalid_input",
        "agent activities are malformed",
      )
    if (activities.length > MAX_AGENT_ACTIVITIES)
      return yield* failRegistry(
        "invalid_input",
        "agent activities exceed display limit",
      )
    return yield* Effect.forEach(activities, activity =>
      Effect.gen(function* () {
        if (
          !isRecordValue(activity) ||
          typeof activity.todoId !== "number" ||
          typeof activity.text !== "string"
        )
          return yield* failRegistry(
            "invalid_input",
            "agent activity is malformed",
          )
        if (!Number.isSafeInteger(activity.todoId) || activity.todoId < 1)
          return yield* failRegistry(
            "invalid_input",
            "agent activity todo id is malformed",
          )
        if (
          activity.status !== "in_progress" &&
          activity.status !== "in_review" &&
          activity.status !== "pending"
        )
          return yield* failRegistry(
            "invalid_input",
            "agent activity status is malformed",
          )
        return {
          todoId: activity.todoId,
          status: activity.status,
          text: yield* boundedTextEffect(
            "agent activity text",
            activity.text,
            MAX_AGENT_ACTIVITY_TEXT,
          ),
        }
      }),
    )
  })

const jsonObjectEffect = (
  encoded: string,
  label: string,
): RegistryEffect<Row> =>
  Effect.try({
    try: (): unknown => JSON.parse(encoded),
    catch: () => registryError("corrupt_state", `${label} is malformed JSON`),
  }).pipe(
    Effect.flatMap(decoded =>
      typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? Effect.succeed(decoded)
        : failRegistry("corrupt_state", `${label} is malformed`),
    ),
  )

const backlogJsonObject = (
  encoded: string,
  label: string,
): RegistryEffect<Row> => jsonObjectEffect(encoded, label)

const backlogItemStateFromRow = (row: Row): RegistryEffect<BacklogItemState> =>
  backlogItemStateEffect(row)

const backlogItemFromRow = (row: Row): RegistryEffect<BacklogItem> =>
  backlogItemEffect(row)

const backlogSourceKind = (value: string): RegistryEffect<BacklogSourceKind> =>
  backlogSourceKindEffect(value)

const backlogAuthorityFromRow = (row: Row): RegistryEffect<BacklogAuthority> =>
  backlogAuthorityEffect(row)

const backlogSourceFromRow = (row: Row): RegistryEffect<BacklogSourceRecord> =>
  backlogSourceEffect(row)

const backlogRequirementFromRow = (
  row: Row,
): RegistryEffect<BacklogRequirementRecord> => backlogRequirementEffect(row)

const backlogStateKind = (
  value: string,
): RegistryEffect<BacklogTransitionRecord["from"]> =>
  backlogStateKindEffect(value)

const backlogTransitionEvent = (
  value: string,
): RegistryEffect<BacklogTransitionRecord["event"]> =>
  backlogTransitionEventEffect(value)

const backlogTransitionFromRow = (
  row: Row,
): RegistryEffect<BacklogTransitionRecord> => backlogTransitionEffect(row)

const backlogEvidencePhase = (
  value: string,
): RegistryEffect<BacklogEvidencePhase> => backlogEvidencePhaseEffect(value)

const backlogEvidenceFromRow = (
  row: Row,
): RegistryEffect<BacklogEvidenceRecord> => backlogEvidenceEffect(row)

const optionalNumberFieldEffect = (
  row: Row,
  key: string,
): RegistryEffect<number | undefined> =>
  row[key] === null ? Effect.succeed(undefined) : requiredNumberField(row, key)

const runtimeVersionsRowEffect = (
  row: Row,
): RegistryEffect<Readonly<Record<string, string>> | undefined> =>
  Effect.gen(function* () {
    const encoded = yield* optionalStringField(row, "runtime_versions")
    if (!encoded) return undefined
    const decoded = yield* Effect.try({
      try: (): unknown => JSON.parse(encoded),
      catch: () =>
        registryError(
          "corrupt_state",
          "registry runtime versions are malformed JSON",
        ),
    })
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    )
      return yield* failRegistry(
        "corrupt_state",
        "registry runtime versions are malformed",
      )
    const entries = Object.entries(decoded)
    if (
      !entries.every(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
    )
      return yield* failRegistry(
        "corrupt_state",
        "registry runtime version value is malformed",
      )
    return yield* validateRuntimeVersionsEffect(
      Object.fromEntries(entries),
    ).pipe(
      Effect.mapError(() =>
        registryError(
          "corrupt_state",
          "registry runtime versions are malformed",
        ),
      ),
    )
  })

const activitiesRowEffect = (
  row: Row,
): RegistryEffect<readonly AgentActivity[]> =>
  Effect.gen(function* () {
    const encoded = yield* optionalStringField(row, "activities")
    if (encoded === undefined) return []
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(encoded),
      catch: () =>
        registryError(
          "corrupt_state",
          "registry agent activities are malformed",
        ),
    })
    if (!Array.isArray(parsed))
      return yield* failRegistry(
        "corrupt_state",
        "registry agent activities are malformed",
      )
    const activities = yield* Effect.forEach(parsed, value =>
      Effect.gen(function* () {
        const activity = yield* rowEffect(value)
        const todoId = activity.todoId
        const status = activity.status
        const text = activity.text
        if (
          typeof todoId !== "number" ||
          !Number.isSafeInteger(todoId) ||
          todoId < 1 ||
          (status !== "in_progress" &&
            status !== "in_review" &&
            status !== "pending") ||
          typeof text !== "string"
        )
          return yield* failRegistry(
            "corrupt_state",
            "registry agent activities are malformed",
          )
        return { todoId, status, text }
      }),
    )
    return yield* validateActivitiesEffect(activities).pipe(
      Effect.mapError(() =>
        registryError(
          "corrupt_state",
          "registry agent activities are malformed",
        ),
      ),
    )
  })

const leaseRowEffect = (row: Row): RegistryEffect<Lease> =>
  Effect.gen(function* () {
    const status = yield* requiredStringField(row, "status")
    const mode = yield* requiredStringField(row, "mode")
    if (status !== "active" && status !== "paused" && status !== "suspended")
      return yield* failRegistry(
        "corrupt_state",
        "registry lease status is malformed",
      )
    if (mode !== "task" && mode !== "operational")
      return yield* failRegistry(
        "corrupt_state",
        "registry lease mode is malformed",
      )
    const runtimeVersions = yield* runtimeVersionsRowEffect(row)
    const model = yield* optionalStringField(row, "owner_model")
    const owner: AgentIdentity = {
      id: yield* requiredStringField(row, "owner_id"),
      pid: yield* requiredNumberField(row, "owner_pid"),
      ...(model ? { model } : {}),
      ...(runtimeVersions ? { runtimeVersions } : {}),
    }
    const base = {
      id: yield* requiredStringField(row, "lease_id"),
      project: yield* requiredStringField(row, "project"),
      role: yield* requiredStringField(row, "role"),
      mode,
      owner,
      policyDigest: yield* requiredStringField(row, "policy_digest"),
      acquiredAt: yield* requiredNumberField(row, "acquired_at"),
      heartbeatAt: yield* requiredNumberField(row, "heartbeat_at"),
      expiresAt: yield* requiredNumberField(row, "expires_at"),
    }
    if (status !== "suspended") return { ...base, status }
    if ((yield* optionalStringField(row, "reason")) !== "policy_changed")
      return yield* failRegistry(
        "corrupt_state",
        "registry lease suspension reason is malformed",
      )
    return { ...base, status, reason: "policy_changed" }
  })

const registeredAgentRowEffect = (row: Row): RegistryEffect<RegisteredAgent> =>
  Effect.gen(function* () {
    const runtimeVersions = yield* runtimeVersionsRowEffect(row)
    const activities = yield* activitiesRowEffect(row)
    const model = yield* optionalStringField(row, "model")
    return {
      identity: {
        id: yield* requiredStringField(row, "agent_id"),
        pid: yield* requiredNumberField(row, "pid"),
        ...(model ? { model } : {}),
        ...(runtimeVersions ? { runtimeVersions } : {}),
      },
      cwd: yield* requiredStringField(row, "cwd"),
      label: yield* requiredStringField(row, "label"),
      usage: {
        input: yield* requiredNumberField(row, "usage_input"),
        output: yield* requiredNumberField(row, "usage_output"),
        cacheRead: yield* requiredNumberField(row, "usage_cache_read"),
        cacheWrite: yield* requiredNumberField(row, "usage_cache_write"),
        totalTokens: yield* requiredNumberField(row, "usage_total"),
      },
      ...(activities.length > 0 ? { activities } : {}),
      heartbeatAt: yield* requiredNumberField(row, "heartbeat_at"),
      expiresAt: yield* requiredNumberField(row, "expires_at"),
    }
  })

const requestRowEffect = (row: Row): RegistryEffect<RegistryRequest> =>
  Effect.gen(function* () {
    const status = yield* requiredStringField(row, "status")
    const requesterAcknowledgedAt = yield* optionalNumberFieldEffect(
      row,
      "requester_acknowledged_at",
    )
    const recipientReceivedAt = yield* optionalNumberFieldEffect(
      row,
      "recipient_received_at",
    )
    const recipientAgentId = yield* optionalStringField(
      row,
      "recipient_agent_id",
    )
    const recipientLeaseId = yield* optionalStringField(
      row,
      "recipient_lease_id",
    )
    const receiptFields = [
      recipientReceivedAt,
      recipientAgentId,
      recipientLeaseId,
    ]
    if (
      receiptFields.some(field => field !== undefined) &&
      receiptFields.some(field => field === undefined)
    )
      return yield* failRegistry(
        "corrupt_state",
        "registry request receipt is malformed",
      )
    const requesterLabel = yield* optionalStringField(row, "requester_label")
    const requesterCwd = yield* optionalStringField(row, "requester_cwd")
    const base = {
      id: yield* requiredStringField(row, "request_id"),
      project: yield* requiredStringField(row, "project"),
      role: yield* requiredStringField(row, "role"),
      requesterId: yield* requiredStringField(row, "requester_id"),
      ...(requesterLabel ? { requesterLabel } : {}),
      ...(requesterCwd ? { requesterCwd } : {}),
      text: yield* requiredStringField(row, "text"),
      priority: yield* requestPriorityEffect(
        yield* requiredStringField(row, "priority"),
      ),
      createdAt: yield* requiredNumberField(row, "created_at"),
      updatedAt: yield* requiredNumberField(row, "updated_at"),
      ...(requesterAcknowledgedAt !== undefined
        ? { requesterAcknowledgedAt }
        : {}),
      ...(recipientReceivedAt !== undefined &&
      recipientAgentId !== undefined &&
      recipientLeaseId !== undefined
        ? { recipientReceivedAt, recipientAgentId, recipientLeaseId }
        : {}),
    }
    if (status === "queued" || status === "cancelled")
      return { ...base, status }
    const leaseId = yield* requiredStringField(row, "lease_id")
    const agentId = yield* requiredStringField(row, "agent_id")
    if (status === "claimed") return { ...base, status, leaseId, agentId }
    if (status === "completed")
      return {
        ...base,
        status,
        leaseId,
        agentId,
        summary: yield* requiredStringField(row, "summary"),
      }
    if (status === "failed") {
      const failure = yield* requiredStringField(row, "failure")
      if (
        failure !== "blocked" &&
        failure !== "cancelled" &&
        failure !== "error" &&
        failure !== "timed_out"
      )
        return yield* failRegistry(
          "corrupt_state",
          "registry request failure is malformed",
        )
      return {
        ...base,
        status,
        leaseId,
        agentId,
        failure,
        diagnostic: yield* requiredStringField(row, "diagnostic"),
      }
    }
    return yield* failRegistry(
      "corrupt_state",
      "registry request status is malformed",
    )
  })

const backlogSourceKindEffect = (
  value: string,
): RegistryEffect<BacklogSourceKind> =>
  value === "owner-message" ||
  value === "bridge-message" ||
  value === "registry-request" ||
  value === "branch-todo" ||
  value === "tracker-item" ||
  value === "backlog-document"
    ? Effect.succeed(value)
    : failRegistry("corrupt_state", "backlog source kind is malformed")

const backlogStateKindEffect = (
  value: string,
): RegistryEffect<BacklogTransitionRecord["from"]> =>
  value === "unreconciled" ||
  value === "ready" ||
  value === "assigned" ||
  value === "implementing" ||
  value === "in-review" ||
  value === "publishing" ||
  value === "blocked" ||
  value === "terminal"
    ? Effect.succeed(value)
    : failRegistry("corrupt_state", "backlog transition state is malformed")

const backlogTransitionEventEffect = (
  value: string,
): RegistryEffect<BacklogTransitionRecord["event"]> =>
  value === "assign" ||
  value === "rebind" ||
  value === "start" ||
  value === "review" ||
  value === "publish" ||
  value === "block" ||
  value === "ready" ||
  value === "complete" ||
  value === "reconcile" ||
  value === "cancel"
    ? Effect.succeed(value)
    : failRegistry("corrupt_state", "backlog transition event is malformed")

const backlogEvidencePhaseEffect = (
  value: string,
): RegistryEffect<BacklogEvidencePhase> =>
  value === "implementation" ||
  value === "review" ||
  value === "publication" ||
  value === "terminal"
    ? Effect.succeed(value)
    : failRegistry("corrupt_state", "backlog evidence phase is malformed")

const backlogAuthorityEffect = (row: Row): RegistryEffect<BacklogAuthority> =>
  Effect.gen(function* () {
    const kind = yield* requiredStringField(row, "authority_kind")
    if (kind === "routing-only") return { kind }
    const ref = yield* optionalStringField(row, "authority_ref")
    if (
      !ref ||
      ref.length > 1_024 ||
      hasUnsafeControlCharacters(ref) ||
      (kind !== "authenticated-owner" && kind !== "repository-policy")
    )
      return yield* failRegistry(
        "corrupt_state",
        "backlog authority is malformed",
      )
    return { kind, ref }
  })

const backlogItemStateEffect = (row: Row): RegistryEffect<BacklogItemState> =>
  Effect.gen(function* () {
    const kind = yield* requiredStringField(row, "state_kind")
    const encoded = yield* requiredStringField(row, "state_json")
    const details = yield* jsonObjectEffect(encoded, "backlog item state")
    if ((yield* requiredStringField(details, "kind")) !== kind)
      return yield* failRegistry(
        "corrupt_state",
        "backlog state kind does not match its encoded state",
      )
    const expectedKeys =
      kind === "unreconciled" || kind === "ready"
        ? ["kind"]
        : kind === "blocked"
          ? ["kind", "reason"]
          : kind === "assigned"
            ? ["agentId", "kind", "leaseId"]
            : kind === "implementing"
              ? ["agentId", "implementationRef", "kind", "leaseId"]
              : kind === "in-review"
                ? [
                    "agentId",
                    "implementationRef",
                    "kind",
                    "leaseId",
                    "reviewRef",
                  ]
                : kind === "publishing"
                  ? [
                      "agentId",
                      "implementationRef",
                      "kind",
                      "leaseId",
                      "publicationRef",
                      "reviewRef",
                    ]
                  : kind === "terminal"
                    ? ["evidence", "kind", "outcome"]
                    : undefined
    if (!expectedKeys)
      return yield* failRegistry(
        "corrupt_state",
        "backlog item state is malformed",
      )
    if (
      Object.keys(details).toSorted().join("\u001f") !==
      expectedKeys.join("\u001f")
    )
      return yield* failRegistry(
        "corrupt_state",
        "backlog state contains unexpected fields",
      )
    if (
      Object.entries(details).some(
        ([key, value]) =>
          key !== "evidence" &&
          (typeof value !== "string" ||
            value.length === 0 ||
            value.length > 4_096 ||
            hasUnsafeControlCharacters(value)),
      )
    )
      return yield* failRegistry(
        "corrupt_state",
        "backlog state contains an unsafe or unbounded field",
      )
    if (kind === "unreconciled" || kind === "ready") return { kind }
    if (kind === "blocked")
      return { kind, reason: yield* requiredStringField(details, "reason") }
    if (kind === "assigned")
      return {
        kind,
        agentId: yield* requiredStringField(details, "agentId"),
        leaseId: yield* requiredStringField(details, "leaseId"),
      }
    if (kind === "implementing")
      return {
        kind,
        agentId: yield* requiredStringField(details, "agentId"),
        leaseId: yield* requiredStringField(details, "leaseId"),
        implementationRef: yield* requiredStringField(
          details,
          "implementationRef",
        ),
      }
    if (kind === "in-review")
      return {
        kind,
        agentId: yield* requiredStringField(details, "agentId"),
        leaseId: yield* requiredStringField(details, "leaseId"),
        implementationRef: yield* requiredStringField(
          details,
          "implementationRef",
        ),
        reviewRef: yield* requiredStringField(details, "reviewRef"),
      }
    if (kind === "publishing")
      return {
        kind,
        agentId: yield* requiredStringField(details, "agentId"),
        leaseId: yield* requiredStringField(details, "leaseId"),
        implementationRef: yield* requiredStringField(
          details,
          "implementationRef",
        ),
        reviewRef: yield* requiredStringField(details, "reviewRef"),
        publicationRef: yield* requiredStringField(details, "publicationRef"),
      }
    if (kind !== "terminal")
      return yield* failRegistry(
        "corrupt_state",
        "backlog item state is malformed",
      )
    const outcome = yield* requiredStringField(details, "outcome")
    if (outcome !== "completed" && outcome !== "cancelled")
      return yield* failRegistry(
        "corrupt_state",
        "backlog terminal state is malformed",
      )
    const evidenceValue = details.evidence
    if (!Array.isArray(evidenceValue) || evidenceValue.length === 0)
      return yield* failRegistry(
        "corrupt_state",
        "backlog terminal state is malformed",
      )
    const evidence = yield* Effect.forEach(evidenceValue, value =>
      Effect.gen(function* () {
        const record = yield* rowEffect(value)
        return {
          kind: yield* persistedStringField(record, "kind", 128),
          ref: yield* persistedStringField(record, "ref", 1_024),
        }
      }),
    )
    return { kind, outcome, evidence }
  })

const backlogItemEffect = (row: Row): RegistryEffect<BacklogItem> =>
  Effect.gen(function* () {
    const priority = yield* requiredStringField(row, "priority")
    if (priority !== "normal" && priority !== "urgent")
      return yield* failRegistry(
        "corrupt_state",
        "backlog priority is malformed",
      )
    const dedupeDigest = yield* persistedStringField(row, "dedupe_digest", 64)
    if (!/^[0-9a-f]{64}$/u.test(dedupeDigest))
      return yield* failRegistry(
        "corrupt_state",
        "registry column dedupe_digest violates its persisted bound",
      )
    const project = yield* persistedStringField(row, "project", 1_024)
    const canonicalProject = yield* canonicalProjectEffect(project).pipe(
      Effect.mapError(() =>
        registryError("corrupt_state", "backlog project is malformed"),
      ),
    )
    if (canonicalProject !== project)
      return yield* failRegistry(
        "corrupt_state",
        "backlog project is not canonical",
      )
    const revision = yield* requiredNumberField(row, "revision")
    const createdAt = yield* requiredNumberField(row, "created_at")
    const updatedAt = yield* requiredNumberField(row, "updated_at")
    if (revision < 1 || createdAt < 0 || updatedAt < createdAt)
      return yield* failRegistry(
        "corrupt_state",
        "backlog revision or timestamp is malformed",
      )
    return {
      id: yield* persistedStringField(row, "item_id", 512),
      project,
      priority,
      state: yield* backlogItemStateEffect(row),
      dedupeDigest,
      revision,
      createdAt,
      updatedAt,
    }
  })

const backlogSourceEffect = (row: Row): RegistryEffect<BacklogSourceRecord> =>
  Effect.gen(function* () {
    const observedAt = yield* requiredNumberField(row, "observed_at")
    const contentDigest = yield* persistedStringField(row, "content_digest", 64)
    if (observedAt < 0 || !/^[0-9a-f]{64}$/u.test(contentDigest))
      return yield* failRegistry(
        "corrupt_state",
        "backlog source timestamp or digest is malformed",
      )
    return {
      kind: yield* backlogSourceKindEffect(
        yield* persistedStringField(row, "source_kind", 64),
      ),
      id: yield* persistedStringField(row, "source_id", 1_024),
      itemId: yield* persistedStringField(row, "item_id", 512),
      authority: yield* backlogAuthorityEffect(row),
      observedAt,
      contentDigest,
    }
  })

const backlogRequirementEffect = (
  row: Row,
): RegistryEffect<BacklogRequirementRecord> =>
  Effect.gen(function* () {
    const digest = yield* persistedStringField(row, "digest", 64)
    if (!/^[0-9a-f]{64}$/u.test(digest))
      return yield* failRegistry(
        "corrupt_state",
        "backlog requirement digest is malformed",
      )
    return {
      id: yield* persistedStringField(row, "requirement_id", 1_024),
      itemId: yield* persistedStringField(row, "item_id", 512),
      sourceKind: yield* backlogSourceKindEffect(
        yield* persistedStringField(row, "source_kind", 64),
      ),
      sourceId: yield* persistedStringField(row, "source_id", 1_024),
      text: yield* persistedStringField(row, "text", 4_000),
      digest,
    }
  })

const backlogTransitionEffect = (
  row: Row,
): RegistryEffect<BacklogTransitionRecord> =>
  Effect.gen(function* () {
    const revision = yield* requiredNumberField(row, "revision")
    const at = yield* requiredNumberField(row, "observed_at")
    if (revision < 1 || at < 0)
      return yield* failRegistry(
        "corrupt_state",
        "backlog transition revision or timestamp is malformed",
      )
    return {
      itemId: yield* persistedStringField(row, "item_id", 512),
      revision,
      actor: yield* persistedStringField(row, "actor", 512),
      event: yield* backlogTransitionEventEffect(
        yield* persistedStringField(row, "event", 64),
      ),
      from: yield* backlogStateKindEffect(
        yield* persistedStringField(row, "prior_state", 64),
      ),
      to: yield* backlogStateKindEffect(
        yield* persistedStringField(row, "next_state", 64),
      ),
      at,
    }
  })

const backlogEvidenceEffect = (
  row: Row,
): RegistryEffect<BacklogEvidenceRecord> =>
  Effect.gen(function* () {
    const at = yield* requiredNumberField(row, "observed_at")
    if (at < 0)
      return yield* failRegistry(
        "corrupt_state",
        "backlog evidence timestamp is malformed",
      )
    return {
      id: yield* persistedStringField(row, "evidence_id", 1_024),
      itemId: yield* persistedStringField(row, "item_id", 512),
      phase: yield* backlogEvidencePhaseEffect(
        yield* persistedStringField(row, "phase", 64),
      ),
      kind: yield* persistedStringField(row, "kind", 128),
      ref: yield* persistedStringField(row, "ref", 1_024),
      at,
    }
  })

const backlogStateEffect = (
  database: DatabaseSync,
  project: string,
): RegistryEffect<BacklogState> =>
  Effect.gen(function* () {
    const canonical = yield* canonicalProjectEffect(project)
    const raw = yield* dbCall("Could not read backlog rows", () => ({
      items: database
        .prepare(
          "SELECT * FROM backlog_items WHERE project = ? ORDER BY created_at, item_id",
        )
        .all(canonical),
      sources: database
        .prepare(
          "SELECT source.* FROM backlog_sources AS source JOIN backlog_items AS item ON item.item_id = source.item_id WHERE item.project = ? ORDER BY source.observed_at, source.source_kind, source.source_id",
        )
        .all(canonical),
      requirements: database
        .prepare(
          "SELECT requirement.* FROM backlog_requirements AS requirement JOIN backlog_items AS item ON item.item_id = requirement.item_id WHERE item.project = ? ORDER BY requirement.requirement_id",
        )
        .all(canonical),
      evidence: database
        .prepare(
          "SELECT evidence.* FROM backlog_evidence AS evidence JOIN backlog_items AS item ON item.item_id = evidence.item_id WHERE item.project = ? ORDER BY evidence.observed_at, evidence.evidence_id",
        )
        .all(canonical),
      transitions: database
        .prepare(
          "SELECT transition.* FROM backlog_transitions AS transition JOIN backlog_items AS item ON item.item_id = transition.item_id WHERE item.project = ? ORDER BY transition.observed_at, transition.revision, transition.transition_id",
        )
        .all(canonical),
    }))
    const itemRows = yield* rowsEffect(raw.items)
    const sourceRows = yield* rowsEffect(raw.sources)
    const requirementRows = yield* rowsEffect(raw.requirements)
    const evidenceRows = yield* rowsEffect(raw.evidence)
    const transitionRows = yield* rowsEffect(raw.transitions)
    const items = yield* Effect.forEach(itemRows, backlogItemEffect)
    const sources = yield* Effect.forEach(sourceRows, backlogSourceEffect)
    const requirements = yield* Effect.forEach(
      requirementRows,
      backlogRequirementEffect,
    )
    const evidence = yield* Effect.forEach(evidenceRows, backlogEvidenceEffect)
    const transitions = yield* Effect.forEach(
      transitionRows,
      backlogTransitionEffect,
    )
    const terminalEvidenceReconciles = items.every(item => {
      if (item.state.kind !== "terminal") return true
      const persisted = evidence.filter(
        record => record.itemId === item.id && record.phase === "terminal",
      )
      return (
        persisted.length === item.state.evidence.length &&
        item.state.evidence.every(expected =>
          persisted.some(
            record =>
              record.kind === expected.kind && record.ref === expected.ref,
          ),
        )
      )
    })
    if (!terminalEvidenceReconciles)
      return yield* failRegistry(
        "corrupt_state",
        "terminal evidence does not reconcile with persisted evidence rows",
      )
    return { items, sources, requirements, evidence, transitions }
  })

const BACKLOG_REQUIREMENT_MAX_CHARACTERS = 4_000

const registryRequestBacklogRequirements = (
  text: string,
): readonly { readonly text: string }[] => {
  const requirements: { readonly text: string }[] = []
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + BACKLOG_REQUIREMENT_MAX_CHARACTERS, text.length)
    if (
      end < text.length &&
      end > offset &&
      /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")
    )
      end -= 1
    requirements.push({ text: text.slice(offset, end) })
    offset = end
  }
  return requirements
}

const persistBacklogIngestionEffect = (
  database: DatabaseSync,
  prior: BacklogState,
  result: IngestBacklogSourceResult,
): RegistryEffect<BacklogState> =>
  Effect.gen(function* () {
    const source = result.state.sources.at(-1)
    if (!source)
      return yield* failRegistry(
        "corrupt_state",
        "backlog source was not produced",
      )
    if (
      prior.sources.some(
        current => current.kind === source.kind && current.id === source.id,
      )
    )
      return result.state
    yield* dbCall("Could not persist backlog ingestion", () => {
      if (result.created) {
        database
          .prepare(
            "INSERT INTO backlog_items (item_id, project, priority, state_kind, state_json, dedupe_digest, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            result.item.id,
            result.item.project,
            result.item.priority,
            result.item.state.kind,
            JSON.stringify(result.item.state),
            result.item.dedupeDigest,
            result.item.revision,
            result.item.createdAt,
            result.item.updatedAt,
          )
      } else {
        database
          .prepare(
            "UPDATE backlog_items SET priority = ?, revision = ?, updated_at = ? WHERE item_id = ?",
          )
          .run(
            result.item.priority,
            result.item.revision,
            result.item.updatedAt,
            result.item.id,
          )
      }
      database
        .prepare(
          "INSERT INTO backlog_sources (source_kind, source_id, item_id, authority_kind, authority_ref, observed_at, content_digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          source.kind,
          source.id,
          source.itemId,
          source.authority.kind,
          source.authority.kind === "routing-only"
            ? null
            : source.authority.ref,
          source.observedAt,
          source.contentDigest,
        )
      const requirements = result.state.requirements.filter(
        requirement =>
          requirement.sourceKind === source.kind &&
          requirement.sourceId === source.id,
      )
      const insertRequirement = database.prepare(
        "INSERT INTO backlog_requirements (requirement_id, item_id, source_kind, source_id, text, digest) VALUES (?, ?, ?, ?, ?, ?)",
      )
      for (const requirement of requirements)
        insertRequirement.run(
          requirement.id,
          requirement.itemId,
          requirement.sourceKind,
          requirement.sourceId,
          requirement.text,
          requirement.digest,
        )
    })
    return result.state
  })

const backlogDomainEffect = <T>(
  operation: Effect.Effect<T, BacklogError>,
): RegistryEffect<T> =>
  operation.pipe(
    Effect.mapError(error => registryError("invalid_input", error.message)),
  )

const persistRegistryRequestBacklogEffect = (
  database: DatabaseSync,
  request: RegistryRequest,
  priorState?: BacklogState,
): RegistryEffect<BacklogState> =>
  Effect.gen(function* () {
    const prior =
      priorState ?? (yield* backlogStateEffect(database, request.project))
    const result = yield* backlogDomainEffect(
      ingestBacklogSource(prior, {
        newItemId: randomUUID(),
        project: request.project,
        source: { kind: "registry-request", id: request.id },
        observedAt: request.createdAt,
        priority: request.priority,
        requirements: registryRequestBacklogRequirements(request.text),
        authority: { kind: "routing-only" },
        dedupe: { kind: "exact-content", scope: request.role },
        initialState: "ready",
      }),
    )
    return yield* persistBacklogIngestionEffect(database, prior, result)
  })

const persistBacklogTransitionEffect = (
  database: DatabaseSync,
  prior: BacklogState,
  next: BacklogState,
  item: BacklogItem,
): RegistryEffect<void> =>
  dbCall("Could not persist backlog transition", () => {
    database
      .prepare(
        "UPDATE backlog_items SET state_kind = ?, state_json = ?, revision = ?, updated_at = ? WHERE item_id = ?",
      )
      .run(
        item.state.kind,
        JSON.stringify(item.state),
        item.revision,
        item.updatedAt,
        item.id,
      )
    const transition = next.transitions.at(-1)
    if (transition)
      database
        .prepare(
          "INSERT INTO backlog_transitions (transition_id, item_id, revision, actor, event, prior_state, next_state, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          transition.itemId,
          transition.revision,
          transition.actor,
          transition.event,
          transition.from,
          transition.to,
          transition.at,
        )
    const priorEvidenceIds = new Set(
      prior.evidence.map(evidence => evidence.id),
    )
    const insertEvidence = database.prepare(
      "INSERT INTO backlog_evidence (evidence_id, item_id, phase, kind, ref, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    for (const evidence of next.evidence) {
      if (evidence.itemId !== item.id || priorEvidenceIds.has(evidence.id))
        continue
      insertEvidence.run(
        evidence.id,
        evidence.itemId,
        evidence.phase,
        evidence.kind,
        evidence.ref,
        evidence.at,
      )
    }
  })

const transitionRegistryRequestBacklogEffect = (
  database: DatabaseSync,
  request: RegistryRequest,
): RegistryEffect<void> =>
  Effect.gen(function* () {
    let state = yield* backlogStateEffect(database, request.project)
    const source = state.sources.find(
      candidate =>
        candidate.kind === "registry-request" && candidate.id === request.id,
    )
    if (!source) return
    let item = state.items.find(candidate => candidate.id === source.itemId)
    if (!item)
      return yield* failRegistry(
        "corrupt_state",
        "linked backlog item is missing",
      )

    const transition = (
      event: Parameters<typeof transitionBacklogItem>[1]["event"],
    ) =>
      backlogDomainEffect(
        transitionBacklogItem(state, {
          itemId: item.id,
          expectedRevision: item.revision,
          actor: "agent-registry",
          now: request.updatedAt,
          event,
        }),
      ).pipe(
        Effect.tap(result =>
          persistBacklogTransitionEffect(
            database,
            state,
            result.state,
            result.item,
          ),
        ),
      )

    if (request.status === "claimed") {
      if (
        item.state.kind === "assigned" &&
        item.state.agentId === request.agentId &&
        item.state.leaseId === request.leaseId
      )
        return
      if (
        (item.state.kind === "assigned" ||
          item.state.kind === "implementing" ||
          item.state.kind === "in-review" ||
          item.state.kind === "publishing") &&
        sameRuntimeSession(item.state.agentId, request.agentId) &&
        item.state.leaseId !== request.leaseId
      ) {
        const verifiedLease = yield* leaseByIdEffect(database, request.leaseId)
        if (
          verifiedLease.owner.id !== request.agentId ||
          verifiedLease.project !== request.project ||
          verifiedLease.role !== request.role ||
          verifiedLease.status !== "active" ||
          verifiedLease.expiresAt <= request.updatedAt
        )
          return yield* failRegistry(
            "stale_lease",
            "replacement lease is not current for this request",
          )
        const priorKind = item.state.kind
        const updated: BacklogItem = {
          ...item,
          revision: item.revision + 1,
          updatedAt: request.updatedAt,
          state: {
            ...item.state,
            agentId: request.agentId,
            leaseId: request.leaseId,
          },
        }
        const reboundState: BacklogState = {
          ...state,
          items: state.items.map(current =>
            current.id === item.id ? updated : current,
          ),
          transitions: [
            ...state.transitions,
            {
              itemId: item.id,
              revision: updated.revision,
              actor: "agent-registry",
              event: "rebind",
              from: priorKind,
              to: priorKind,
              at: request.updatedAt,
            },
          ],
        }
        yield* persistBacklogTransitionEffect(
          database,
          state,
          reboundState,
          updated,
        )
        return
      }
      if (item.state.kind !== "ready") return
      yield* transition({
        kind: "assign",
        agentId: request.agentId,
        leaseId: request.leaseId,
      })
      return
    }

    if (request.status === "completed") {
      if (item.state.kind === "assigned") {
        const started = yield* transition({
          kind: "start",
          implementationRef: request.id,
        })
        state = started.state
        item = started.item
      }
      const evidence = [
        { kind: "registry-outcome", ref: request.id },
        { kind: "implementation-summary", ref: request.id },
      ] as const
      if (item.state.kind === "terminal") {
        if (item.state.outcome === "cancelled")
          return yield* failRegistry(
            "invalid_transition",
            "cancelled backlog item cannot be completed",
          )
        if (
          evidence.every(expected =>
            item.state.kind === "terminal"
              ? item.state.evidence.some(
                  current =>
                    current.kind === expected.kind &&
                    current.ref === expected.ref,
                )
              : false,
          )
        )
          return
        const added = evidence.filter(
          expected =>
            item.state.kind === "terminal" &&
            !item.state.evidence.some(
              current =>
                current.kind === expected.kind && current.ref === expected.ref,
            ),
        )
        const updated: BacklogItem = {
          ...item,
          revision: item.revision + 1,
          updatedAt: request.updatedAt,
          state: {
            ...item.state,
            evidence: [...item.state.evidence, ...added],
          },
        }
        const addedEvidence: readonly BacklogEvidenceRecord[] = added.map(
          (record, index) => ({
            id: `${item.id}:${updated.revision}:terminal:${index}`,
            itemId: item.id,
            phase: "terminal",
            kind: record.kind,
            ref: record.ref,
            at: request.updatedAt,
          }),
        )
        const nextState: BacklogState = {
          ...state,
          items: state.items.map(current =>
            current.id === item.id ? updated : current,
          ),
          evidence: [...state.evidence, ...addedEvidence],
          transitions: [
            ...state.transitions,
            {
              itemId: item.id,
              revision: updated.revision,
              actor: "agent-registry",
              event: "complete",
              from: "terminal",
              to: "terminal",
              at: request.updatedAt,
            },
          ],
        }
        yield* persistBacklogTransitionEffect(
          database,
          state,
          nextState,
          updated,
        )
        return
      }
      yield* transition({ kind: "complete", evidence })
      return
    }

    if (request.status === "cancelled") {
      if (item.state.kind === "terminal") return
      yield* transition({
        kind: "cancel",
        evidence: [{ kind: "registry-cancellation", ref: request.id }],
      })
      return
    }

    if (request.status === "failed" && item.state.kind !== "terminal")
      yield* transition(
        request.failure === "cancelled"
          ? {
              kind: "cancel",
              evidence: [{ kind: "registry-failure", ref: request.id }],
            }
          : {
              kind: "block",
              reason: `registry request ${request.failure}`,
            },
      )
  })

const advanceRegistryRequestBacklogEffect = (
  database: DatabaseSync,
  request: RegistryRequest,
  input: AdvanceRequestBacklogInput,
): RegistryEffect<void> =>
  Effect.gen(function* () {
    const state = yield* backlogStateEffect(database, request.project)
    const source = state.sources.find(
      candidate =>
        candidate.kind === "registry-request" && candidate.id === request.id,
    )
    if (!source)
      return yield* failRegistry(
        "corrupt_state",
        "linked backlog source is missing",
      )
    const item = state.items.find(candidate => candidate.id === source.itemId)
    if (!item)
      return yield* failRegistry(
        "corrupt_state",
        "linked backlog item is missing",
      )
    if (item.state.kind === "terminal")
      return yield* failRegistry(
        "invalid_transition",
        "backlog item is terminal",
      )
    if (
      item.state.kind !== "ready" &&
      (item.state.agentId !== input.agentId ||
        item.state.leaseId !== input.leaseId)
    )
      return yield* failRegistry(
        "invalid_transition",
        "backlog item is assigned to another lease",
      )

    const ref = yield* boundedTextEffect(
      "backlog phase evidence",
      input.evidenceRef,
      1_024,
    )
    if (
      (input.phase === "implementation" &&
        item.state.kind === "implementing" &&
        item.state.implementationRef === ref) ||
      (input.phase === "review" &&
        item.state.kind === "in-review" &&
        item.state.reviewRef === ref) ||
      (input.phase === "publication" &&
        item.state.kind === "publishing" &&
        item.state.publicationRef === ref)
    )
      return

    const event =
      input.phase === "implementation"
        ? ({ kind: "start", implementationRef: ref } as const)
        : input.phase === "review"
          ? ({ kind: "review", reviewRef: ref } as const)
          : ({ kind: "publish", publicationRef: ref } as const)
    const result = yield* backlogDomainEffect(
      transitionBacklogItem(state, {
        itemId: item.id,
        expectedRevision: item.revision,
        actor: input.agentId,
        now: input.now,
        event,
      }),
    )
    yield* persistBacklogTransitionEffect(
      database,
      state,
      result.state,
      result.item,
    )
  })

const installBacklogSchema = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS backlog_items (
      item_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      priority TEXT NOT NULL,
      state_kind TEXT NOT NULL,
      state_json TEXT NOT NULL,
      dedupe_digest TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS backlog_items_project_state
      ON backlog_items (project, state_kind, created_at, item_id);
    CREATE TABLE IF NOT EXISTS backlog_sources (
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      authority_kind TEXT NOT NULL,
      authority_ref TEXT,
      observed_at INTEGER NOT NULL,
      content_digest TEXT NOT NULL,
      PRIMARY KEY (source_kind, source_id),
      FOREIGN KEY (item_id) REFERENCES backlog_items(item_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS backlog_sources_item
      ON backlog_sources (item_id, observed_at, source_kind, source_id);
    CREATE TABLE IF NOT EXISTS backlog_requirements (
      requirement_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      text TEXT NOT NULL,
      digest TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES backlog_items(item_id),
      FOREIGN KEY (source_kind, source_id)
        REFERENCES backlog_sources(source_kind, source_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS backlog_requirements_item
      ON backlog_requirements (item_id, requirement_id);
    CREATE TABLE IF NOT EXISTS backlog_evidence (
      evidence_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES backlog_items(item_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backlog_transitions (
      transition_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      prior_state TEXT NOT NULL,
      next_state TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES backlog_items(item_id)
    ) STRICT;
  `)
}

const schemaVersionEffect = (database: DatabaseSync): RegistryEffect<number> =>
  dbCall("Could not read registry schema version", () =>
    database.prepare("PRAGMA user_version").get(),
  ).pipe(
    Effect.flatMap(rowEffect),
    Effect.flatMap(row => requiredNumberField(row, "user_version")),
  )

const tableColumnsEffect = (
  database: DatabaseSync,
  table: string,
): RegistryEffect<ReadonlySet<string>> =>
  dbCall("Could not read registry table schema", () =>
    database.prepare(`PRAGMA table_info(${table})`).all(),
  ).pipe(
    Effect.flatMap(rowsEffect),
    Effect.flatMap(rows =>
      Effect.forEach(rows, row => requiredStringField(row, "name")),
    ),
    Effect.map(columns => new Set(columns)),
  )

const currentAdditiveSchemaEffect = (
  database: DatabaseSync,
): RegistryEffect<boolean> =>
  Effect.gen(function* () {
    const requests = yield* tableColumnsEffect(database, "requests")
    const leases = yield* tableColumnsEffect(database, "leases")
    const agents = yield* tableColumnsEffect(database, "agents")
    const backlogItems = yield* tableColumnsEffect(database, "backlog_items")
    const backlogSources = yield* tableColumnsEffect(
      database,
      "backlog_sources",
    )
    const backlogRequirements = yield* tableColumnsEffect(
      database,
      "backlog_requirements",
    )
    return (
      [
        "requester_acknowledged_at",
        "requester_label",
        "requester_cwd",
        "recipient_received_at",
        "recipient_agent_id",
        "recipient_lease_id",
        "priority",
      ].every(column => requests.has(column)) &&
      leases.has("runtime_versions") &&
      [
        "agent_id",
        "runtime_versions",
        "cwd",
        "label",
        "usage_input",
        "usage_output",
        "usage_cache_read",
        "usage_cache_write",
        "usage_total",
        "activities",
        "expires_at",
      ].every(column => agents.has(column)) &&
      [
        "item_id",
        "project",
        "priority",
        "state_kind",
        "state_json",
        "dedupe_digest",
        "revision",
        "created_at",
        "updated_at",
      ].every(column => backlogItems.has(column)) &&
      [
        "source_kind",
        "source_id",
        "item_id",
        "authority_kind",
        "authority_ref",
        "observed_at",
        "content_digest",
      ].every(column => backlogSources.has(column)) &&
      [
        "requirement_id",
        "item_id",
        "source_kind",
        "source_id",
        "text",
        "digest",
      ].every(column => backlogRequirements.has(column))
    )
  })

const backfillOpenRegistryRequestsEffect = (
  database: DatabaseSync,
): RegistryEffect<void> =>
  Effect.gen(function* () {
    const raw = yield* dbCall(
      "Could not read requests for backlog backfill",
      () =>
        database
          .prepare(
            "SELECT * FROM requests WHERE status IN ('queued', 'claimed') ORDER BY created_at, request_id",
          )
          .all(),
    )
    const rows = yield* rowsEffect(raw)
    const requests = yield* Effect.forEach(rows, requestRowEffect)
    const states = new Map<string, BacklogState>()
    for (const request of requests) {
      const prior =
        states.get(request.project) ??
        (yield* backlogStateEffect(database, request.project))
      const existing = yield* dbCall("Could not inspect backlog backfill", () =>
        database
          .prepare(
            "SELECT 1 AS present FROM backlog_sources WHERE source_kind = 'registry-request' AND source_id = ?",
          )
          .get(request.id),
      )
      if (existing === undefined)
        yield* persistRegistryRequestBacklogEffect(database, request, prior)
      yield* transitionRegistryRequestBacklogEffect(database, request)
      states.set(
        request.project,
        yield* backlogStateEffect(database, request.project),
      )
    }
  })

const initializeEffect = (
  database: DatabaseSync,
  databasePath: string,
): RegistryEffect<void> =>
  Effect.gen(function* () {
    const journalRaw = yield* dbCall("Could not initialize registry", () => {
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
      return database.prepare("PRAGMA journal_mode").get()
    })
    const journalRow = yield* rowEffect(journalRaw)
    const journalMode = yield* requiredStringField(journalRow, "journal_mode")
    if (journalMode.toLowerCase() !== "wal")
      yield* dbCall("Could not enable registry WAL", () =>
        database.prepare("PRAGMA journal_mode = WAL").get(),
      ).pipe(
        Effect.catchIf(
          error => error.code === "busy",
          () => Effect.void,
        ),
      )
    yield* dbCall("Could not configure registry", () => {
      database.exec("PRAGMA synchronous = NORMAL;")
      database.exec("PRAGMA foreign_keys = ON;")
    })
    const observedVersion = yield* schemaVersionEffect(database)
    if (
      observedVersion === SCHEMA_VERSION &&
      (yield* currentAdditiveSchemaEffect(database))
    ) {
      yield* dbCall("Could not secure registry database", () =>
        chmodSync(databasePath, 0o600),
      )
      return
    }
    if (![0, 1, 2, 3, 4, 5].includes(observedVersion))
      return yield* failRegistry(
        "corrupt_state",
        `unsupported agent registry schema version ${observedVersion}`,
      )

    yield* transactionEffect(
      database,
      Effect.gen(function* () {
        const currentVersion = yield* schemaVersionEffect(database)
        if (currentVersion === 0)
          yield* dbCall("Could not create registry schema", () =>
            database.exec(`
              CREATE TABLE agents (
                agent_id TEXT PRIMARY KEY,
                pid INTEGER NOT NULL,
                model TEXT,
                runtime_versions TEXT,
                cwd TEXT NOT NULL,
                label TEXT NOT NULL,
                usage_input INTEGER NOT NULL,
                usage_output INTEGER NOT NULL,
                usage_cache_read INTEGER NOT NULL,
                usage_cache_write INTEGER NOT NULL,
                usage_total INTEGER NOT NULL,
                activities TEXT,
                heartbeat_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
              ) STRICT;
              CREATE TABLE leases (
                project TEXT NOT NULL,
                role TEXT NOT NULL,
                lease_id TEXT NOT NULL UNIQUE,
                mode TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                owner_pid INTEGER NOT NULL,
                owner_model TEXT,
                runtime_versions TEXT,
                policy_digest TEXT NOT NULL,
                acquired_at INTEGER NOT NULL,
                heartbeat_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                reason TEXT,
                PRIMARY KEY (project, role)
              ) STRICT;
              CREATE TABLE requests (
                request_id TEXT PRIMARY KEY,
                project TEXT NOT NULL,
                role TEXT NOT NULL,
                requester_id TEXT NOT NULL,
                requester_label TEXT,
                requester_cwd TEXT,
                text TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT 'normal',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                requester_acknowledged_at INTEGER,
                recipient_received_at INTEGER,
                recipient_agent_id TEXT,
                recipient_lease_id TEXT,
                status TEXT NOT NULL,
                lease_id TEXT,
                agent_id TEXT,
                summary TEXT,
                failure TEXT,
                diagnostic TEXT
              ) STRICT;
            `),
          )
        else {
          yield* dbCall("Could not migrate registry agents", () =>
            database.exec(`
              CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                pid INTEGER NOT NULL,
                model TEXT,
                runtime_versions TEXT,
                cwd TEXT NOT NULL,
                label TEXT NOT NULL,
                usage_input INTEGER NOT NULL DEFAULT 0,
                usage_output INTEGER NOT NULL DEFAULT 0,
                usage_cache_read INTEGER NOT NULL DEFAULT 0,
                usage_cache_write INTEGER NOT NULL DEFAULT 0,
                usage_total INTEGER NOT NULL DEFAULT 0,
                activities TEXT,
                heartbeat_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
              ) STRICT;
            `),
          )
          const columns = new Set(
            yield* tableColumnsEffect(database, "requests"),
          )
          const agentColumns = new Set(
            yield* tableColumnsEffect(database, "agents"),
          )
          const leaseColumns = yield* tableColumnsEffect(database, "leases")
          const addColumn = (
            known: Set<string>,
            name: string,
            declaration: string,
          ): RegistryEffect<void> =>
            known.has(name)
              ? Effect.void
              : dbCall("Could not add registry column", () => {
                  database.exec(
                    `ALTER TABLE requests ADD COLUMN ${declaration};`,
                  )
                  known.add(name)
                })
          const addAgentColumn = (
            name: string,
            declaration: string,
          ): RegistryEffect<void> =>
            agentColumns.has(name)
              ? Effect.void
              : dbCall("Could not add registry agent column", () => {
                  database.exec(`ALTER TABLE agents ADD COLUMN ${declaration};`)
                  agentColumns.add(name)
                })
          yield* addAgentColumn(
            "usage_input",
            "usage_input INTEGER NOT NULL DEFAULT 0",
          )
          yield* addAgentColumn(
            "usage_output",
            "usage_output INTEGER NOT NULL DEFAULT 0",
          )
          yield* addAgentColumn(
            "usage_cache_read",
            "usage_cache_read INTEGER NOT NULL DEFAULT 0",
          )
          yield* addAgentColumn(
            "usage_cache_write",
            "usage_cache_write INTEGER NOT NULL DEFAULT 0",
          )
          yield* addAgentColumn(
            "usage_total",
            "usage_total INTEGER NOT NULL DEFAULT 0",
          )
          yield* addAgentColumn("activities", "activities TEXT")
          if (!leaseColumns.has("runtime_versions"))
            yield* dbCall("Could not add lease runtime versions", () =>
              database.exec(
                "ALTER TABLE leases ADD COLUMN runtime_versions TEXT;",
              ),
            )
          if (currentVersion === 1)
            yield* addColumn(
              columns,
              "requester_acknowledged_at",
              "requester_acknowledged_at INTEGER",
            )
          yield* addColumn(columns, "requester_label", "requester_label TEXT")
          yield* addColumn(columns, "requester_cwd", "requester_cwd TEXT")
          yield* addColumn(
            columns,
            "recipient_received_at",
            "recipient_received_at INTEGER",
          )
          yield* addColumn(
            columns,
            "recipient_agent_id",
            "recipient_agent_id TEXT",
          )
          yield* addColumn(
            columns,
            "recipient_lease_id",
            "recipient_lease_id TEXT",
          )
          yield* addColumn(
            columns,
            "priority",
            "priority TEXT NOT NULL DEFAULT 'normal'",
          )
        }
        yield* dbCall("Could not install backlog schema", () =>
          installBacklogSchema(database),
        )
        yield* backfillOpenRegistryRequestsEffect(database)
        yield* dbCall("Could not advance registry schema", () =>
          database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`),
        )
      }),
    )
    yield* dbCall("Could not secure registry database", () =>
      chmodSync(databasePath, 0o600),
    )
  })

interface DatabaseAccess {
  readonly use: <T>(
    label: string,
    operation: (database: DatabaseSync) => RegistryEffect<T>,
  ) => RegistryEffect<T>
  readonly close: () => void
}

const makeDatabaseAccess = (databasePath: string): DatabaseAccess => {
  let database: DatabaseSync | undefined

  const openEffect = (label: string): RegistryEffect<DatabaseSync> => {
    if (database) return Effect.succeed(database)
    return dbCall(label, () => {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
      return new DatabaseSync(databasePath)
    }).pipe(
      Effect.flatMap(opened =>
        initializeEffect(opened, databasePath).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              database = opened
            }),
          ),
          Effect.as(opened),
          Effect.catchAll(error =>
            dbCall("Could not close invalid registry", () =>
              opened.close(),
            ).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        ),
      ),
    )
  }

  return {
    use: (label, operation) =>
      openEffect(label).pipe(Effect.flatMap(operation)),
    close: () => {
      const active = database
      database = undefined
      if (active)
        void Effect.runPromise(
          dbCall("Could not close registry", () => active.close()).pipe(
            Effect.ignore,
          ),
        )
    },
  }
}

const countEffect = (
  database: DatabaseSync,
  table: "leases" | "requests",
): RegistryEffect<number> =>
  dbCall("Could not count registry records", () =>
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
  ).pipe(
    Effect.flatMap(rowEffect),
    Effect.flatMap(row => requiredNumberField(row, "count")),
  )

const leaseByIdEffect = (
  database: DatabaseSync,
  leaseId: string,
): RegistryEffect<Lease> =>
  Effect.gen(function* () {
    const raw = yield* dbCall("Could not read lease", () =>
      database.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId),
    )
    const row = yield* optionalRowEffect(raw)
    if (!row)
      return yield* failRegistry("stale_lease", "stale or invalid lease owner")
    return yield* leaseRowEffect(row)
  })

const currentLeaseEffect = (
  database: DatabaseSync,
  leaseId: string,
  agentId: string,
  now: number,
): RegistryEffect<Lease> =>
  Effect.gen(function* () {
    const lease = yield* leaseByIdEffect(database, leaseId)
    if (
      lease.owner.id !== agentId ||
      lease.expiresAt <= now ||
      lease.status !== "active"
    )
      return yield* failRegistry("stale_lease", "stale or invalid lease owner")
    return lease
  })

const requestByIdEffect = (
  database: DatabaseSync,
  requestId: string,
): RegistryEffect<RegistryRequest> =>
  Effect.gen(function* () {
    const raw = yield* dbCall("Could not read request", () =>
      database
        .prepare("SELECT * FROM requests WHERE request_id = ?")
        .get(requestId),
    )
    const row = yield* optionalRowEffect(raw)
    if (!row) return yield* failRegistry("not_found", "request not found")
    return yield* requestRowEffect(row)
  })

const migrateLegacyRuntimeIdentityEffect = (
  database: DatabaseSync,
  identity: AgentIdentity,
): RegistryEffect<void> =>
  Effect.gen(function* () {
    const runtime = parseRuntimeAgentId(identity.id)
    if (!runtime || runtime.pid !== identity.pid) return
    const legacyRaw = yield* dbCall(
      "Could not migrate runtime identity",
      () => {
        database
          .prepare(
            `UPDATE leases
           SET owner_id = ?
           WHERE owner_id = ? AND owner_pid = ?`,
          )
          .run(identity.id, runtime.sessionId, identity.pid)
        database
          .prepare(
            `UPDATE requests
           SET agent_id = ?
           WHERE status = 'claimed'
             AND agent_id = ?
             AND lease_id IN (SELECT lease_id FROM leases WHERE owner_id = ?)`,
          )
          .run(identity.id, runtime.sessionId, identity.id)
        return database
          .prepare("SELECT pid FROM agents WHERE agent_id = ?")
          .get(runtime.sessionId)
      },
    )
    const legacy = yield* optionalRowEffect(legacyRaw)
    if (!legacy) return
    const pid = yield* requiredNumberField(legacy, "pid")
    if (pid !== identity.pid) return
    yield* dbCall("Could not remove legacy runtime identity", () =>
      database
        .prepare("DELETE FROM agents WHERE agent_id = ? AND pid = ?")
        .run(runtime.sessionId, identity.pid),
    )
  })

const persistMessageBacklogEffect = (
  database: DatabaseSync,
  message: MessageBacklogRecord,
): RegistryEffect<BacklogState> =>
  Effect.gen(function* () {
    const prior = yield* backlogStateEffect(database, message.project)
    const result = yield* backlogDomainEffect(
      ingestBacklogSource(prior, {
        newItemId: randomUUID(),
        project: message.project,
        source: { kind: message.source, id: message.messageId },
        observedAt: message.observedAt,
        priority: "normal",
        requirements: message.requirements.map(text => ({ text })),
        authority:
          message.authority === "authenticated-owner"
            ? { kind: "authenticated-owner", ref: message.messageId }
            : { kind: "routing-only" },
        dedupe: { kind: "exact-content" },
        initialState: "ready",
      }),
    )
    return yield* persistBacklogIngestionEffect(database, prior, result)
  })

const reconcileCanonicalBacklogEffect = (
  database: DatabaseSync,
  snapshot: CanonicalBacklogSnapshot,
): RegistryEffect<BacklogState> =>
  Effect.gen(function* () {
    let state = yield* backlogStateEffect(database, snapshot.project)
    const groups = new Map<
      string,
      CanonicalBacklogSnapshot["items"][number][]
    >()
    for (const record of snapshot.items)
      groups.set(record.canonicalId, [
        ...(groups.get(record.canonicalId) ?? []),
        record,
      ])

    for (const [canonicalId, records] of groups) {
      const status = records[0]?.status
      if (!status || records.some(record => record.status !== status))
        return yield* failRegistry(
          "invalid_input",
          "canonical backlog records disagree on lifecycle state",
        )
      const sourcePrefix = `${snapshot.scopeId}:${canonicalId}:`
      const existingSource = state.sources.find(
        source =>
          source.kind === snapshot.source && source.id.startsWith(sourcePrefix),
      )
      if ((status === "completed" || status === "cancelled") && !existingSource)
        continue

      let item = existingSource
        ? state.items.find(current => current.id === existingSource.itemId)
        : undefined
      for (const record of records) {
        const result = yield* backlogDomainEffect(
          ingestBacklogSource(state, {
            newItemId: randomUUID(),
            project: snapshot.project,
            source: { kind: snapshot.source, id: record.sourceId },
            observedAt: snapshot.observedAt,
            priority: record.priority,
            requirements: record.requirements.map(text => ({ text })),
            authority: { kind: "routing-only" },
            dedupe: item
              ? { kind: "item-id", itemId: item.id }
              : {
                  kind: "canonical-key",
                  key: `${snapshot.source}:${snapshot.scopeId}:${canonicalId}`,
                },
            initialState: "ready",
          }),
        )
        state = yield* persistBacklogIngestionEffect(database, state, result)
        item = result.item
      }
      if (!item || item.state.kind === "terminal") continue

      let event:
        Parameters<typeof transitionBacklogItem>[1]["event"] | undefined
      if (status === "completed")
        event = {
          kind: "reconcile",
          outcome: "completed",
          evidence: [
            {
              kind: `${snapshot.source}-status`,
              ref: `${snapshot.scopeId}:${canonicalId}`,
            },
          ],
        }
      else if (status === "cancelled")
        event = {
          kind: "reconcile",
          outcome: "cancelled",
          evidence: [
            {
              kind: `${snapshot.source}-status`,
              ref: `${snapshot.scopeId}:${canonicalId}`,
            },
          ],
        }
      else if (status === "blocked") {
        const reason = records[0]?.reason
        if (!reason)
          return yield* failRegistry(
            "invalid_input",
            "blocked canonical backlog item is missing its reason",
          )
        if (item.state.kind !== "blocked" || item.state.reason !== reason)
          event = { kind: "block", reason }
      } else if (item.state.kind === "blocked") event = { kind: "ready" }

      if (!event) continue
      const result = yield* backlogDomainEffect(
        transitionBacklogItem(state, {
          itemId: item.id,
          expectedRevision: item.revision,
          actor: `${snapshot.source}-adapter`,
          now: snapshot.observedAt,
          event,
        }),
      )
      yield* persistBacklogTransitionEffect(
        database,
        state,
        result.state,
        result.item,
      )
      state = result.state
    }
    return state
  })

const reconcileBranchTodoBacklogEffect = (
  database: DatabaseSync,
  snapshot: BranchTodoBacklogSnapshot,
): RegistryEffect<BacklogState> =>
  Effect.gen(function* () {
    let state = yield* backlogStateEffect(database, snapshot.project)
    const groups = new Map<
      string,
      BranchTodoBacklogSnapshot["todos"][number][]
    >()
    for (const todo of snapshot.todos)
      groups.set(todo.canonicalId, [
        ...(groups.get(todo.canonicalId) ?? []),
        todo,
      ])

    for (const [canonicalId, records] of groups) {
      const status = records[0]?.status
      if (!status || records.some(record => record.status !== status))
        return yield* failRegistry(
          "invalid_input",
          "branch todo snapshots disagree on lifecycle state",
        )
      const existingSource = state.sources.find(
        source =>
          source.kind === "branch-todo" &&
          source.id.startsWith(`${canonicalId}:`),
      )
      if ((status === "completed" || status === "cancelled") && !existingSource)
        continue

      let item = existingSource
        ? state.items.find(current => current.id === existingSource.itemId)
        : undefined
      for (const record of records) {
        const result = yield* backlogDomainEffect(
          ingestBacklogSource(state, {
            newItemId: randomUUID(),
            project: snapshot.project,
            source: { kind: "branch-todo", id: record.sourceId },
            observedAt: snapshot.observedAt,
            priority: "normal",
            requirements: record.requirements.map(text => ({ text })),
            authority: { kind: "routing-only" },
            dedupe: item
              ? { kind: "item-id", itemId: item.id }
              : { kind: "canonical-key", key: canonicalId },
            initialState: "ready",
          }),
        )
        state = yield* persistBacklogIngestionEffect(database, state, result)
        item = result.item
      }
      if (!item || item.state.kind === "terminal") continue

      let event:
        Parameters<typeof transitionBacklogItem>[1]["event"] | undefined
      if (status === "completed")
        event = {
          kind: "reconcile",
          outcome: "completed",
          evidence: [{ kind: "branch-todo-status", ref: canonicalId }],
        }
      else if (status === "cancelled")
        event = {
          kind: "reconcile",
          outcome: "cancelled",
          evidence: [{ kind: "branch-todo-status", ref: canonicalId }],
        }
      else if (status === "blocked") {
        const reason = records[0]?.reason
        if (!reason)
          return yield* failRegistry(
            "invalid_input",
            "blocked branch todo is missing its reason",
          )
        if (item.state.kind !== "blocked" || item.state.reason !== reason)
          event = { kind: "block", reason }
      } else if (item.state.kind === "blocked") event = { kind: "ready" }

      if (!event) continue
      const result = yield* backlogDomainEffect(
        transitionBacklogItem(state, {
          itemId: item.id,
          expectedRevision: item.revision,
          actor: "branch-todo-adapter",
          now: snapshot.observedAt,
          event,
        }),
      )
      yield* persistBacklogTransitionEffect(
        database,
        state,
        result.state,
        result.item,
      )
      state = result.state
    }
    return state
  })

const useDatabaseEffect = <T>(
  access: DatabaseAccess,
  label: string,
  operation: (database: DatabaseSync) => RegistryEffect<T>,
): RegistryEffect<T> => access.use(label, operation)

const effect: <T>(
  label: string,
  operation: () => T,
) => Effect.Effect<T, RegistryError> = (label, operation) =>
  Effect.try({ try: operation, catch: error => asRegistryError(error, label) })

export const makeSqliteRegistryStore: (
  root: string,
) => SqliteRegistryStore = root => {
  const databasePath = join(root, "registry.sqlite")
  const databaseAccess = makeDatabaseAccess(databasePath)
  const withDatabase = databaseAccess.use

  return {
    close: databaseAccess.close,
    snapshot: now =>
      useDatabaseEffect(databaseAccess, "Could not read registry", database =>
        Effect.gen(function* () {
          const timestamp = yield* validateTimeEffect("now", now)
          const raw = yield* dbCall("Could not read registry", () => ({
            agents: database
              .prepare(
                "SELECT * FROM agents WHERE expires_at > ? ORDER BY label, agent_id",
              )
              .all(timestamp),
            leases: database
              .prepare(
                "SELECT * FROM leases WHERE expires_at > ? ORDER BY project, role",
              )
              .all(timestamp),
            requests: database
              .prepare(
                "SELECT * FROM requests WHERE requester_acknowledged_at IS NULL ORDER BY created_at, request_id",
              )
              .all(),
          }))
          const agentRows = yield* rowsEffect(raw.agents)
          const leaseRows = yield* rowsEffect(raw.leases)
          const requestRows = yield* rowsEffect(raw.requests)
          return {
            version: 1,
            agents: yield* Effect.forEach(agentRows, registeredAgentRowEffect),
            leases: yield* Effect.forEach(leaseRows, leaseRowEffect),
            requests: yield* Effect.forEach(requestRows, requestRowEffect),
          } satisfies RegistrySnapshot
        }),
      ),

    backlogProjects: () =>
      useDatabaseEffect(
        databaseAccess,
        "Could not list backlog projects",
        database =>
          Effect.gen(function* () {
            const raw = yield* dbCall("Could not list backlog projects", () =>
              database
                .prepare(
                  "SELECT DISTINCT project FROM backlog_items ORDER BY project LIMIT ?",
                )
                .all(MAX_BACKLOG_PROJECTS + 1),
            )
            const rows = yield* rowsEffect(raw)
            if (rows.length > MAX_BACKLOG_PROJECTS)
              return yield* failRegistry(
                "capacity",
                "backlog project limit reached",
              )
            return yield* Effect.forEach(rows, row =>
              Effect.gen(function* () {
                const project = yield* persistedStringField(
                  row,
                  "project",
                  1_024,
                )
                const canonical = yield* canonicalProjectEffect(project).pipe(
                  Effect.mapError(() =>
                    registryError(
                      "corrupt_state",
                      "backlog project is malformed",
                    ),
                  ),
                )
                if (canonical !== project)
                  return yield* failRegistry(
                    "corrupt_state",
                    "backlog project is not canonical",
                  )
                return project
              }),
            )
          }),
      ),

    backlogSnapshot: project =>
      useDatabaseEffect(databaseAccess, "Could not read backlog", database =>
        backlogStateEffect(database, project),
      ),

    reconcileBranchTodos: snapshot =>
      useDatabaseEffect(
        databaseAccess,
        "Could not reconcile branch todos",
        database =>
          transactionEffect(
            database,
            reconcileBranchTodoBacklogEffect(database, snapshot),
          ),
      ),

    ingestMessage: message =>
      useDatabaseEffect(
        databaseAccess,
        "Could not ingest owner or bridge message",
        database =>
          transactionEffect(
            database,
            persistMessageBacklogEffect(database, message),
          ),
      ),

    reconcileCanonicalBacklog: snapshot =>
      useDatabaseEffect(
        databaseAccess,
        "Could not reconcile canonical external backlog",
        database =>
          transactionEffect(
            database,
            reconcileCanonicalBacklogEffect(database, snapshot),
          ),
      ),

    heartbeatAgent: (input: AgentHeartbeatInput) =>
      useDatabaseEffect(
        databaseAccess,
        "Could not heartbeat agent presence",
        database =>
          transactionEffect(
            database,
            Effect.gen(function* () {
              const now = yield* validateTimeEffect("now", input.now)
              const ttlMs = yield* validateTtlEffect(input.ttlMs)
              const identity = yield* validateAgentEffect(input.agent)
              const cwd = yield* canonicalProjectEffect(input.cwd)
              const label = yield* boundedTextEffect(
                "agent label",
                input.label,
                160,
              )
              const usage = yield* validateTokenUsageEffect(input.usage)
              const activities = yield* validateActivitiesEffect(
                input.activities,
              )
              const agent: RegisteredAgent = {
                identity,
                cwd,
                label,
                usage,
                ...(activities.length > 0 ? { activities } : {}),
                heartbeatAt: now,
                expiresAt: yield* expiresAtEffect(now, ttlMs),
              }
              yield* migrateLegacyRuntimeIdentityEffect(database, identity)
              yield* dbCall("Could not persist agent heartbeat", () => {
                database
                  .prepare("DELETE FROM agents WHERE expires_at <= ?")
                  .run(now)
                database
                  .prepare(
                    `INSERT INTO agents (
                    agent_id, pid, model, runtime_versions, cwd, label,
                    usage_input, usage_output, usage_cache_read, usage_cache_write, usage_total,
                    activities, heartbeat_at, expires_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(agent_id) DO UPDATE SET
                    pid = excluded.pid,
                    model = excluded.model,
                    runtime_versions = excluded.runtime_versions,
                    cwd = excluded.cwd,
                    label = excluded.label,
                    usage_input = excluded.usage_input,
                    usage_output = excluded.usage_output,
                    usage_cache_read = excluded.usage_cache_read,
                    usage_cache_write = excluded.usage_cache_write,
                    usage_total = excluded.usage_total,
                    activities = excluded.activities,
                    heartbeat_at = excluded.heartbeat_at,
                    expires_at = excluded.expires_at`,
                  )
                  .run(
                    identity.id,
                    identity.pid,
                    identity.model ?? null,
                    identity.runtimeVersions
                      ? JSON.stringify(identity.runtimeVersions)
                      : null,
                    cwd,
                    label,
                    usage.input,
                    usage.output,
                    usage.cacheRead,
                    usage.cacheWrite,
                    usage.totalTokens,
                    JSON.stringify(activities),
                    agent.heartbeatAt,
                    agent.expiresAt,
                  )
              })
              return agent
            }),
          ),
      ),

    claim: (input: ClaimLeaseInput) =>
      useDatabaseEffect(databaseAccess, "Could not claim role", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const ttlMs = yield* validateTtlEffect(input.ttlMs)
            const owner = yield* validateAgentEffect(input.agent)
            const project = yield* canonicalProjectEffect(input.project)
            const role = yield* roleNameEffect(input.role)
            const mode = yield* leaseModeEffect(input.mode)
            const policyDigest = yield* boundedTextEffect(
              "policy digest",
              input.policyDigest,
              256,
            )
            const existingRaw = yield* dbCall("Could not inspect role", () => {
              database
                .prepare("DELETE FROM leases WHERE expires_at <= ?")
                .run(now)
              return database
                .prepare("SELECT * FROM leases WHERE project = ? AND role = ?")
                .get(project, role)
            })
            const existingRow = yield* optionalRowEffect(existingRaw)
            if (existingRow) {
              const existing = yield* leaseRowEffect(existingRow)
              if (existing.expiresAt > now)
                return {
                  outcome: "already_owned",
                  lease: existing,
                } satisfies ClaimLeaseResult
              yield* dbCall("Could not remove expired role lease", () =>
                database
                  .prepare("DELETE FROM leases WHERE project = ? AND role = ?")
                  .run(project, role),
              )
            }
            if ((yield* countEffect(database, "leases")) >= MAX_LEASES)
              return yield* failRegistry("capacity", "lease capacity reached")
            const lease: Lease = {
              id: randomUUID(),
              project,
              role,
              mode,
              owner,
              policyDigest,
              acquiredAt: now,
              heartbeatAt: now,
              expiresAt: yield* expiresAtEffect(now, ttlMs),
              status: "active",
            }
            yield* dbCall("Could not persist role lease", () =>
              database
                .prepare(
                  `INSERT INTO leases (
                  project, role, lease_id, mode, owner_id, owner_pid, owner_model, runtime_versions,
                  policy_digest, acquired_at, heartbeat_at, expires_at, status, reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
                )
                .run(
                  lease.project,
                  lease.role,
                  lease.id,
                  lease.mode,
                  lease.owner.id,
                  lease.owner.pid,
                  lease.owner.model ?? null,
                  lease.owner.runtimeVersions
                    ? JSON.stringify(lease.owner.runtimeVersions)
                    : null,
                  lease.policyDigest,
                  lease.acquiredAt,
                  lease.heartbeatAt,
                  lease.expiresAt,
                  lease.status,
                ),
            )
            return { outcome: "claimed", lease } satisfies ClaimLeaseResult
          }),
        ),
      ),

    heartbeat: (input: HeartbeatInput) =>
      useDatabaseEffect(databaseAccess, "Could not heartbeat lease", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const ttlMs = yield* validateTtlEffect(input.ttlMs)
            const policyDigest = yield* boundedTextEffect(
              "policy digest",
              input.policyDigest,
              256,
            )
            const runtimeVersions = yield* validateRuntimeVersionsEffect(
              input.runtimeVersions,
            )
            const lease = yield* leaseByIdEffect(database, input.leaseId)
            if (lease.owner.id !== input.agentId || lease.expiresAt <= now)
              return yield* failRegistry(
                "stale_lease",
                "stale or invalid lease owner",
              )
            const status =
              lease.policyDigest === policyDigest &&
              lease.status !== "suspended"
                ? lease.status
                : "suspended"
            const reason = status === "suspended" ? "policy_changed" : null
            const expiration = yield* expiresAtEffect(now, ttlMs)
            yield* dbCall("Could not persist lease heartbeat", () =>
              database
                .prepare(
                  "UPDATE leases SET heartbeat_at = ?, expires_at = ?, status = ?, reason = ?, runtime_versions = ? WHERE lease_id = ?",
                )
                .run(
                  now,
                  expiration,
                  status,
                  reason,
                  runtimeVersions ? JSON.stringify(runtimeVersions) : null,
                  lease.id,
                ),
            )
            const owner = {
              ...lease.owner,
              ...(runtimeVersions ? { runtimeVersions } : {}),
            }
            return status === "suspended"
              ? {
                  ...lease,
                  owner,
                  heartbeatAt: now,
                  expiresAt: expiration,
                  status,
                  reason: "policy_changed" as const,
                }
              : {
                  ...lease,
                  owner,
                  heartbeatAt: now,
                  expiresAt: expiration,
                  status,
                }
          }),
        ),
      ),

    pause: (input: PauseLeaseInput) =>
      useDatabaseEffect(databaseAccess, "Could not pause lease", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const lease = yield* leaseByIdEffect(database, input.leaseId)
            if (
              lease.owner.id !== input.agentId ||
              lease.expiresAt <= now ||
              lease.status === "suspended"
            )
              return yield* failRegistry(
                "stale_lease",
                "stale or invalid lease owner",
              )
            yield* dbCall("Could not pause lease", () =>
              database
                .prepare(
                  "UPDATE leases SET status = 'paused' WHERE lease_id = ?",
                )
                .run(lease.id),
            )
            return { ...lease, status: "paused" as const }
          }),
        ),
      ),

    resume: (input: HeartbeatInput) =>
      useDatabaseEffect(databaseAccess, "Could not resume lease", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const ttlMs = yield* validateTtlEffect(input.ttlMs)
            const policyDigest = yield* boundedTextEffect(
              "policy digest",
              input.policyDigest,
              256,
            )
            const runtimeVersions = yield* validateRuntimeVersionsEffect(
              input.runtimeVersions,
            )
            const lease = yield* leaseByIdEffect(database, input.leaseId)
            if (
              lease.owner.id !== input.agentId ||
              lease.expiresAt <= now ||
              lease.status !== "paused" ||
              lease.policyDigest !== policyDigest
            )
              return yield* failRegistry(
                "stale_lease",
                "paused lease cannot resume under this owner or policy",
              )
            const expiration = yield* expiresAtEffect(now, ttlMs)
            yield* dbCall("Could not resume lease", () =>
              database
                .prepare(
                  "UPDATE leases SET heartbeat_at = ?, expires_at = ?, status = 'active', reason = NULL, runtime_versions = ? WHERE lease_id = ?",
                )
                .run(
                  now,
                  expiration,
                  runtimeVersions ? JSON.stringify(runtimeVersions) : null,
                  lease.id,
                ),
            )
            const owner = {
              ...lease.owner,
              ...(runtimeVersions ? { runtimeVersions } : {}),
            }
            return {
              ...lease,
              owner,
              heartbeatAt: now,
              expiresAt: expiration,
              status: "active" as const,
            }
          }),
        ),
      ),

    release: (input: ReleaseLeaseInput) =>
      useDatabaseEffect(databaseAccess, "Could not release lease", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            yield* validateTimeEffect("now", input.now)
            const changes = yield* dbCall("Could not release lease", () =>
              Number(
                database
                  .prepare(
                    "DELETE FROM leases WHERE lease_id = ? AND owner_id = ?",
                  )
                  .run(input.leaseId, input.agentId).changes,
              ),
            )
            if (changes !== 1)
              return yield* failRegistry(
                "stale_lease",
                "stale or invalid lease owner",
              )
          }),
        ),
      ),

    enqueue: (input: EnqueueRequestInput) =>
      useDatabaseEffect(databaseAccess, "Could not queue request", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            if ((yield* countEffect(database, "requests")) >= MAX_REQUESTS)
              return yield* failRegistry("capacity", "request capacity reached")
            const now = yield* validateTimeEffect("now", input.now)
            const requesterLabel = input.requesterLabel
              ? yield* boundedTextEffect(
                  "requester label",
                  input.requesterLabel,
                  160,
                )
              : undefined
            const requesterCwd = input.requesterCwd
              ? yield* canonicalProjectEffect(input.requesterCwd)
              : undefined
            const request: RegistryRequest = {
              id: randomUUID(),
              project: yield* canonicalProjectEffect(input.project),
              role: yield* roleNameEffect(input.role),
              requesterId: yield* boundedTextEffect(
                "requester id",
                input.requesterId,
                128,
              ),
              ...(requesterLabel ? { requesterLabel } : {}),
              ...(requesterCwd ? { requesterCwd } : {}),
              text: yield* persistedTextEffect(
                "request",
                input.text,
                MAX_REQUEST_TEXT,
              ),
              priority: yield* requestPriorityEffect(
                input.priority ?? "normal",
                "invalid_input",
              ),
              createdAt: now,
              updatedAt: now,
              status: "queued",
            }
            yield* dbCall("Could not persist request", () =>
              database
                .prepare(
                  "INSERT INTO requests (request_id, project, role, requester_id, requester_label, requester_cwd, text, priority, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .run(
                  request.id,
                  request.project,
                  request.role,
                  request.requesterId,
                  request.requesterLabel ?? null,
                  request.requesterCwd ?? null,
                  request.text,
                  request.priority,
                  request.createdAt,
                  request.updatedAt,
                  request.status,
                ),
            )
            yield* persistRegistryRequestBacklogEffect(database, request)
            return request
          }),
        ),
      ),

    receiveRequest: (input: ReceiveRequestInput) =>
      useDatabaseEffect(databaseAccess, "Could not receive request", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const lease = yield* currentLeaseEffect(
              database,
              input.leaseId,
              input.agentId,
              now,
            )
            const request = yield* requestByIdEffect(database, input.requestId)
            if (
              request.project !== lease.project ||
              request.role !== lease.role
            )
              return yield* failRegistry(
                "stale_lease",
                "lease does not own the request role",
              )
            if (request.status !== "queued")
              return yield* failRegistry(
                "invalid_transition",
                "only queued requests can be received",
              )
            if (
              request.recipientLeaseId === lease.id &&
              request.recipientAgentId === lease.owner.id &&
              request.recipientReceivedAt !== undefined
            )
              return request
            const changes = yield* dbCall("Could not receive request", () =>
              Number(
                database
                  .prepare(
                    `UPDATE requests
                    SET recipient_received_at = ?, recipient_agent_id = ?, recipient_lease_id = ?
                    WHERE request_id = ? AND status = 'queued'`,
                  )
                  .run(now, lease.owner.id, lease.id, request.id).changes,
              ),
            )
            if (changes !== 1)
              return yield* failRegistry(
                "invalid_transition",
                "request receipt transition lost race",
              )
            return {
              ...request,
              recipientReceivedAt: now,
              recipientAgentId: lease.owner.id,
              recipientLeaseId: lease.id,
            }
          }),
        ),
      ),

    acknowledgeRequest: (input: AcknowledgeRequestInput) =>
      useDatabaseEffect(
        databaseAccess,
        "Could not acknowledge request",
        database =>
          transactionEffect(
            database,
            Effect.gen(function* () {
              const now = yield* validateTimeEffect("now", input.now)
              const request = yield* requestByIdEffect(
                database,
                input.requestId,
              )
              if (request.requesterId !== input.requesterId)
                return yield* failRegistry(
                  "invalid_transition",
                  "only the requester can acknowledge this request",
                )
              if (
                request.status !== "completed" &&
                request.status !== "failed" &&
                request.status !== "cancelled"
              )
                return yield* failRegistry(
                  "invalid_transition",
                  "only terminal requests can be acknowledged",
                )
              yield* dbCall("Could not acknowledge request", () =>
                database
                  .prepare(
                    "UPDATE requests SET requester_acknowledged_at = ? WHERE request_id = ?",
                  )
                  .run(now, request.id),
              )
              return { ...request, requesterAcknowledgedAt: now }
            }),
          ),
      ),

    cancelRequest: (input: CancelRequestInput) =>
      useDatabaseEffect(databaseAccess, "Could not cancel request", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const request = yield* requestByIdEffect(database, input.requestId)
            if (request.requesterId !== input.requesterId)
              return yield* failRegistry(
                "invalid_transition",
                "only the requester can cancel this request",
              )
            if (
              request.status === "completed" ||
              request.status === "failed" ||
              request.status === "cancelled"
            )
              return yield* failRegistry(
                "invalid_transition",
                "request is already terminal",
              )
            const changes = yield* dbCall("Could not cancel request", () =>
              Number(
                database
                  .prepare(
                    "UPDATE requests SET status = 'cancelled', updated_at = ? WHERE request_id = ? AND status IN ('queued', 'claimed')",
                  )
                  .run(now, request.id).changes,
              ),
            )
            if (changes !== 1)
              return yield* failRegistry(
                "invalid_transition",
                "request terminal transition lost race",
              )
            const cancelled: RegistryRequest = {
              ...request,
              status: "cancelled",
              updatedAt: now,
            }
            yield* transitionRegistryRequestBacklogEffect(database, cancelled)
            return cancelled
          }),
        ),
      ),

    clearExceptProject: (input: ClearExceptProjectInput) =>
      useDatabaseEffect(databaseAccess, "Could not clear registry", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            yield* validateTimeEffect("now", input.now)
            const preservedProject = yield* canonicalProjectEffect(
              input.preservedProject,
            )
            const raw = yield* dbCall(
              "Could not inspect registry clear set",
              () => ({
                requests: database
                  .prepare("SELECT request_id, project FROM requests")
                  .all(),
                backlog: database
                  .prepare("SELECT item_id, project FROM backlog_items")
                  .all(),
                leases: database
                  .prepare("SELECT lease_id, project FROM leases")
                  .all(),
                agents: database
                  .prepare("SELECT agent_id, cwd FROM agents")
                  .all(),
              }),
            )
            const outsideProjectIds = (
              value: unknown,
              idKey: string,
              projectKey: string,
            ): RegistryEffect<readonly string[]> =>
              rowsEffect(value).pipe(
                Effect.flatMap(rows =>
                  Effect.forEach(rows, row =>
                    Effect.gen(function* () {
                      const id = yield* requiredStringField(row, idKey)
                      const project = yield* requiredStringField(
                        row,
                        projectKey,
                      )
                      const canonical = yield* canonicalProjectEffect(project)
                      return { id, canonical }
                    }),
                  ),
                ),
                Effect.map(records =>
                  records
                    .filter(
                      record =>
                        !isWithinProject(record.canonical, preservedProject),
                    )
                    .map(record => record.id),
                ),
              )
            const requestIds = yield* outsideProjectIds(
              raw.requests,
              "request_id",
              "project",
            )
            const backlogItemIds = yield* outsideProjectIds(
              raw.backlog,
              "item_id",
              "project",
            )
            const leaseIds = yield* outsideProjectIds(
              raw.leases,
              "lease_id",
              "project",
            )
            const agentIds = yield* outsideProjectIds(
              raw.agents,
              "agent_id",
              "cwd",
            )
            yield* dbCall("Could not clear registry", () => {
              const deleteRequest = database.prepare(
                "DELETE FROM requests WHERE request_id = ?",
              )
              const deleteBacklogRequirements = database.prepare(
                "DELETE FROM backlog_requirements WHERE item_id = ?",
              )
              const deleteBacklogEvidence = database.prepare(
                "DELETE FROM backlog_evidence WHERE item_id = ?",
              )
              const deleteBacklogTransitions = database.prepare(
                "DELETE FROM backlog_transitions WHERE item_id = ?",
              )
              const deleteBacklogSources = database.prepare(
                "DELETE FROM backlog_sources WHERE item_id = ?",
              )
              const deleteBacklogItem = database.prepare(
                "DELETE FROM backlog_items WHERE item_id = ?",
              )
              const deleteLease = database.prepare(
                "DELETE FROM leases WHERE lease_id = ?",
              )
              const deleteAgent = database.prepare(
                "DELETE FROM agents WHERE agent_id = ?",
              )
              for (const requestId of requestIds) deleteRequest.run(requestId)
              for (const itemId of backlogItemIds) {
                deleteBacklogRequirements.run(itemId)
                deleteBacklogEvidence.run(itemId)
                deleteBacklogTransitions.run(itemId)
                deleteBacklogSources.run(itemId)
                deleteBacklogItem.run(itemId)
              }
              for (const leaseId of leaseIds) deleteLease.run(leaseId)
              for (const agentId of agentIds) deleteAgent.run(agentId)
            })
            return {
              agents: agentIds.length,
              leases: leaseIds.length,
              requests: requestIds.length,
            } satisfies ClearedRegistryCounts
          }),
        ),
      ),

    claimRequest: (input: ClaimRequestInput) =>
      useDatabaseEffect(databaseAccess, "Could not claim request", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const lease = yield* currentLeaseEffect(
              database,
              input.leaseId,
              input.agentId,
              now,
            )
            const request = yield* requestByIdEffect(database, input.requestId)
            if (
              request.project !== lease.project ||
              request.role !== lease.role
            )
              return yield* failRegistry(
                "stale_lease",
                "lease does not own the request role",
              )
            if (request.status === "claimed") {
              const prior = yield* dbCall("Could not inspect prior lease", () =>
                database
                  .prepare(
                    "SELECT * FROM leases WHERE lease_id = ? AND expires_at > ?",
                  )
                  .get(request.leaseId, now),
              )
              if (prior)
                return yield* failRegistry(
                  "invalid_transition",
                  "request is already claimed by a live lease",
                )
            } else if (request.status !== "queued")
              return yield* failRegistry(
                "invalid_transition",
                "request is not claimable",
              )
            yield* dbCall("Could not claim request", () =>
              database
                .prepare(
                  "UPDATE requests SET status = 'claimed', lease_id = ?, agent_id = ?, updated_at = ?, summary = NULL, failure = NULL, diagnostic = NULL WHERE request_id = ?",
                )
                .run(lease.id, lease.owner.id, now, request.id),
            )
            const claimed: RegistryRequest = {
              ...request,
              status: "claimed",
              leaseId: lease.id,
              agentId: lease.owner.id,
              updatedAt: now,
            }
            yield* transitionRegistryRequestBacklogEffect(database, claimed)
            return claimed
          }),
        ),
      ),

    advanceRequestBacklog: (input: AdvanceRequestBacklogInput) =>
      useDatabaseEffect(
        databaseAccess,
        "Could not advance request backlog",
        database =>
          transactionEffect(
            database,
            Effect.gen(function* () {
              const now = yield* validateTimeEffect("now", input.now)
              const lease = yield* currentLeaseEffect(
                database,
                input.leaseId,
                input.agentId,
                now,
              )
              const request = yield* requestByIdEffect(
                database,
                input.requestId,
              )
              if (
                request.status !== "claimed" ||
                request.leaseId !== lease.id ||
                request.agentId !== lease.owner.id
              )
                return yield* failRegistry(
                  "invalid_transition",
                  "request is not claimed by this lease",
                )
              yield* advanceRegistryRequestBacklogEffect(
                database,
                request,
                input,
              )
              return request
            }),
          ),
      ),

    completeRequest: (input: CompleteRequestInput) =>
      useDatabaseEffect(
        databaseAccess,
        "Could not complete request",
        database =>
          transactionEffect(
            database,
            Effect.gen(function* () {
              const now = yield* validateTimeEffect("now", input.now)
              const lease = yield* currentLeaseEffect(
                database,
                input.leaseId,
                input.agentId,
                now,
              )
              const request = yield* requestByIdEffect(
                database,
                input.requestId,
              )
              if (
                request.status !== "claimed" ||
                request.leaseId !== lease.id ||
                request.agentId !== lease.owner.id
              )
                return yield* failRegistry(
                  "invalid_transition",
                  "request is not claimed by this lease",
                )
              const summary = yield* persistedTextEffect(
                "summary",
                input.summary,
                MAX_SUMMARY_TEXT,
              )
              const changes = yield* dbCall("Could not complete request", () =>
                Number(
                  database
                    .prepare(
                      "UPDATE requests SET status = 'completed', summary = ?, updated_at = ? WHERE request_id = ? AND status = 'claimed' AND lease_id = ?",
                    )
                    .run(summary, now, request.id, lease.id).changes,
                ),
              )
              if (changes !== 1)
                return yield* failRegistry(
                  "invalid_transition",
                  "request terminal transition lost race",
                )
              const completed: RegistryRequest = {
                ...request,
                status: "completed",
                summary,
                updatedAt: now,
              }
              yield* transitionRegistryRequestBacklogEffect(database, completed)
              return completed
            }),
          ),
      ),

    failRequest: (input: FailRequestInput) =>
      useDatabaseEffect(databaseAccess, "Could not fail request", database =>
        transactionEffect(
          database,
          Effect.gen(function* () {
            const now = yield* validateTimeEffect("now", input.now)
            const lease = yield* currentLeaseEffect(
              database,
              input.leaseId,
              input.agentId,
              now,
            )
            const request = yield* requestByIdEffect(database, input.requestId)
            if (
              request.status !== "claimed" ||
              request.leaseId !== lease.id ||
              request.agentId !== lease.owner.id
            )
              return yield* failRegistry(
                "invalid_transition",
                "request is not claimed by this lease",
              )
            const failure = yield* requestFailureEffect(input.failure)
            const diagnostic = yield* persistedTextEffect(
              "diagnostic",
              input.diagnostic,
              MAX_SUMMARY_TEXT,
            )
            const changes = yield* dbCall("Could not fail request", () =>
              Number(
                database
                  .prepare(
                    "UPDATE requests SET status = 'failed', failure = ?, diagnostic = ?, updated_at = ? WHERE request_id = ? AND status = 'claimed' AND lease_id = ?",
                  )
                  .run(failure, diagnostic, now, request.id, lease.id).changes,
              ),
            )
            if (changes !== 1)
              return yield* failRegistry(
                "invalid_transition",
                "request terminal transition lost race",
              )
            const failed: RegistryRequest = {
              ...request,
              status: "failed",
              failure,
              diagnostic,
              updatedAt: now,
            }
            yield* transitionRegistryRequestBacklogEffect(database, failed)
            return failed
          }),
        ),
      ),
  }
}
