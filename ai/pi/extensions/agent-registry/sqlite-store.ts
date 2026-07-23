import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  RegistryError,
  type AcknowledgeRequestInput,
  type AgentIdentity,
  type CancelRequestInput,
  type ClaimLeaseInput,
  type ClaimLeaseResult,
  type ClaimRequestInput,
  type CompleteRequestInput,
  type EnqueueRequestInput,
  type FailRequestInput,
  type HeartbeatInput,
  type Lease,
  type PauseLeaseInput,
  type RegistryRequest,
  type RegistrySnapshot,
  type RegistryStore,
  type ReleaseLeaseInput,
} from "./registry.ts";

const SCHEMA_VERSION = 3;
const MAX_LEASES = 1_024;
const MAX_REQUESTS = 10_000;
const MAX_REQUEST_TEXT = 8_000;
const MAX_SUMMARY_TEXT = 4_000;
const BUSY_TIMEOUT_MS = 2_000;
const SENSITIVE_TEXT =
  /(^|[\\/\s'"])(?:\.env(?:\.[^\\/\s'"]*)?|credentials\.json|secrets\.(?:json|ya?ml)|auth\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/\s'"]+\.(?:key|pem|p12|pfx))($|[\\/\s'"])/i;

type Row = Readonly<Record<string, unknown>>;

const rowFrom: (value: unknown) => Row = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw registryError("corrupt_state", "registry query returned a malformed row");
  }
  return value;
};

const optionalRowFrom: (value: unknown) => Row | undefined = (value) =>
  value === undefined ? undefined : rowFrom(value);

const rowsFrom: (value: unknown) => readonly Row[] = (value) => {
  if (!Array.isArray(value)) throw registryError("corrupt_state", "registry query returned malformed rows");
  return value.map(rowFrom);
};

const registryError: (code: RegistryError["code"], message: string) => RegistryError = (code, message) =>
  new RegistryError({ code, message });

const asRegistryError: (error: unknown, fallback: string) => RegistryError = (error, fallback) => {
  if (error instanceof RegistryError) return error;
  const message = error instanceof Error ? error.message : "";
  return registryError(/busy|locked/i.test(message) ? "busy" : "io", fallback);
};

const hasUnsafeControlCharacters: (text: string) => boolean = (text) =>
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);

const boundedText: (label: string, text: string, maximum: number) => string = (label, text, maximum) => {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maximum || hasUnsafeControlCharacters(trimmed)) {
    throw registryError("invalid_input", `${label} must contain 1-${maximum} safe characters`);
  }
  return trimmed;
};

const persistedText: (label: string, text: string, maximum: number) => string = (label, text, maximum) => {
  const bounded = boundedText(label, text, maximum);
  if (SENSITIVE_TEXT.test(bounded)) {
    throw registryError("invalid_input", `${label} contains a protected credential-shaped path`);
  }
  return bounded;
};

const canonicalProject: (project: string) => string = (project) => {
  const trimmed = project.trim();
  if (!isAbsolute(trimmed) || trimmed.length > 1_024 || hasUnsafeControlCharacters(trimmed)) {
    throw registryError("invalid_input", "project must be a bounded absolute path");
  }
  return normalize(trimmed).replace(/\/$/, "") || "/";
};

const roleName: (role: string) => string = (role) => {
  const normalized = role.trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) {
    throw registryError("invalid_input", "role must match [a-z][a-z0-9-]{0,63}");
  }
  return normalized;
};

const validateAgent: (agent: AgentIdentity) => AgentIdentity = (agent) => {
  const id = boundedText("agent id", agent.id, 128);
  if (!Number.isSafeInteger(agent.pid) || agent.pid < 1) throw registryError("invalid_input", "pid must be positive");
  const model = agent.model ? boundedText("model", agent.model, 256) : undefined;
  return { id, pid: agent.pid, ...(model ? { model } : {}) };
};

const validateTime: (label: string, value: number) => number = (label, value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw registryError("invalid_input", `${label} must be a timestamp`);
  return value;
};

const validateTtl: (ttlMs: number) => number = (ttlMs) => {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1_000) {
    throw registryError("invalid_input", "ttlMs must be between 1ms and 24h");
  }
  return ttlMs;
};

const expiresAt: (now: number, ttlMs: number) => number = (now, ttlMs) => {
  const expiration = now + ttlMs;
  if (!Number.isSafeInteger(expiration)) throw registryError("invalid_input", "lease expiration exceeds safe time range");
  return expiration;
};

const stringField: (row: Row, key: string, optional?: boolean) => string | undefined = (row, key, optional = false) => {
  const value = row[key];
  if (optional && value === null) return undefined;
  if (typeof value !== "string") throw registryError("corrupt_state", `registry column ${key} is malformed`);
  return value;
};

const numberField: (row: Row, key: string) => number = (row, key) => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw registryError("corrupt_state", `registry column ${key} is malformed`);
  }
  return value;
};

const optionalNumberField: (row: Row, key: string) => number | undefined = (row, key) => {
  const value = row[key];
  if (value === null) return undefined;
  return numberField(row, key);
};

const leaseFromRow: (row: Row) => Lease = (row) => {
  const status = stringField(row, "status");
  const mode = stringField(row, "mode");
  if (status !== "active" && status !== "paused" && status !== "suspended") {
    throw registryError("corrupt_state", "registry lease status is malformed");
  }
  if (mode !== "task" && mode !== "operational") {
    throw registryError("corrupt_state", "registry lease mode is malformed");
  }
  const owner: AgentIdentity = {
    id: stringField(row, "owner_id") ?? "",
    pid: numberField(row, "owner_pid"),
    ...(stringField(row, "owner_model", true) ? { model: stringField(row, "owner_model", true) } : {}),
  };
  const base = {
    id: stringField(row, "lease_id") ?? "",
    project: stringField(row, "project") ?? "",
    role: stringField(row, "role") ?? "",
    mode,
    owner,
    policyDigest: stringField(row, "policy_digest") ?? "",
    acquiredAt: numberField(row, "acquired_at"),
    heartbeatAt: numberField(row, "heartbeat_at"),
    expiresAt: numberField(row, "expires_at"),
  };
  if (status === "suspended") {
    if (stringField(row, "reason", true) !== "policy_changed") {
      throw registryError("corrupt_state", "registry lease suspension reason is malformed");
    }
    return { ...base, status, reason: "policy_changed" };
  }
  return { ...base, status };
};

const requestFromRow: (row: Row) => RegistryRequest = (row) => {
  const status = stringField(row, "status");
  const requesterAcknowledgedAt = optionalNumberField(row, "requester_acknowledged_at");
  const base = {
    id: stringField(row, "request_id") ?? "",
    project: stringField(row, "project") ?? "",
    role: stringField(row, "role") ?? "",
    requesterId: stringField(row, "requester_id") ?? "",
    ...(stringField(row, "requester_label", true) ? { requesterLabel: stringField(row, "requester_label", true) } : {}),
    ...(stringField(row, "requester_cwd", true) ? { requesterCwd: stringField(row, "requester_cwd", true) } : {}),
    text: stringField(row, "text") ?? "",
    createdAt: numberField(row, "created_at"),
    updatedAt: numberField(row, "updated_at"),
    ...(requesterAcknowledgedAt !== undefined ? { requesterAcknowledgedAt } : {}),
  };
  if (status === "queued" || status === "cancelled") return { ...base, status };
  const leaseId = stringField(row, "lease_id") ?? "";
  const agentId = stringField(row, "agent_id") ?? "";
  if (status === "claimed") return { ...base, status, leaseId, agentId };
  if (status === "completed") {
    return { ...base, status, leaseId, agentId, summary: stringField(row, "summary") ?? "" };
  }
  if (status === "failed") {
    const failure = stringField(row, "failure");
    if (failure !== "blocked" && failure !== "cancelled" && failure !== "error" && failure !== "timed_out") {
      throw registryError("corrupt_state", "registry request failure is malformed");
    }
    return {
      ...base,
      status,
      leaseId,
      agentId,
      failure,
      diagnostic: stringField(row, "diagnostic") ?? "",
    };
  }
  throw registryError("corrupt_state", "registry request status is malformed");
};

const schemaVersion: (database: DatabaseSync) => number = (database) =>
  numberField(rowFrom(database.prepare("PRAGMA user_version").get()), "user_version");

const initialize: (database: DatabaseSync, databasePath: string) => void = (database, databasePath) => {
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  const observedVersion = schemaVersion(database);
  if (observedVersion === SCHEMA_VERSION) {
    chmodSync(databasePath, 0o600);
    return;
  }
  if (observedVersion !== 0 && observedVersion !== 1 && observedVersion !== 2) {
    throw registryError("corrupt_state", `unsupported agent registry schema version ${observedVersion}`);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const currentVersion = schemaVersion(database);
    if (currentVersion === 0) {
      database.exec(`
        CREATE TABLE leases (
          project TEXT NOT NULL,
          role TEXT NOT NULL,
          lease_id TEXT NOT NULL UNIQUE,
          mode TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          owner_pid INTEGER NOT NULL,
          owner_model TEXT,
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
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          requester_acknowledged_at INTEGER,
          status TEXT NOT NULL,
          lease_id TEXT,
          agent_id TEXT,
          summary TEXT,
          failure TEXT,
          diagnostic TEXT
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    } else if (currentVersion === 1) {
      database.exec(`
        ALTER TABLE requests ADD COLUMN requester_acknowledged_at INTEGER;
        ALTER TABLE requests ADD COLUMN requester_label TEXT;
        ALTER TABLE requests ADD COLUMN requester_cwd TEXT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    } else if (currentVersion === 2) {
      database.exec(`
        ALTER TABLE requests ADD COLUMN requester_label TEXT;
        ALTER TABLE requests ADD COLUMN requester_cwd TEXT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    } else if (currentVersion !== SCHEMA_VERSION) {
      throw registryError("corrupt_state", `unsupported agent registry schema version ${currentVersion}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original typed failure.
    }
    throw error;
  }
  chmodSync(databasePath, 0o600);
};

const withDatabase: <T>(databasePath: string, use: (database: DatabaseSync) => T) => T = (databasePath, use) => {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  try {
    initialize(database, databasePath);
    return use(database);
  } finally {
    database.close();
  }
};

const transaction: <T>(database: DatabaseSync, mutate: () => T) => T = (database, mutate) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = mutate();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original typed failure.
    }
    throw error;
  }
};

const count: (database: DatabaseSync, table: "leases" | "requests") => number = (database, table) => {
  const row = rowFrom(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
  return numberField(row, "count");
};

const currentLease: (
  database: DatabaseSync,
  leaseId: string,
  agentId: string,
  now: number,
) => Lease = (database, leaseId, agentId, now) => {
  const row = optionalRowFrom(database.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId));
  if (!row) throw registryError("stale_lease", "stale or invalid lease owner");
  const lease = leaseFromRow(row);
  if (lease.owner.id !== agentId || lease.expiresAt <= now || lease.status !== "active") {
    throw registryError("stale_lease", "stale or invalid lease owner");
  }
  return lease;
};

const requestRow: (database: DatabaseSync, requestId: string) => Row = (database, requestId) => {
  const row = optionalRowFrom(database.prepare("SELECT * FROM requests WHERE request_id = ?").get(requestId));
  if (!row) throw registryError("not_found", "request not found");
  return row;
};

const effect: <T>(label: string, operation: () => T) => Effect.Effect<T, RegistryError> = (label, operation) =>
  Effect.try({ try: operation, catch: (error) => asRegistryError(error, label) });

export const makeSqliteRegistryStore: (root: string) => RegistryStore = (root) => {
  const databasePath = join(root, "registry.sqlite");

  return {
    snapshot: (now) =>
      effect("Could not read registry", () => {
        const timestamp = validateTime("now", now);
        return withDatabase(databasePath, (database): RegistrySnapshot => ({
          version: 1,
          leases: rowsFrom(database.prepare("SELECT * FROM leases WHERE expires_at > ? ORDER BY project, role").all(timestamp)).map(leaseFromRow),
          requests: rowsFrom(database.prepare("SELECT * FROM requests ORDER BY created_at, request_id").all()).map(requestFromRow),
        }));
      }),

    claim: (input: ClaimLeaseInput) =>
      effect("Could not claim role", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): ClaimLeaseResult => {
            const now = validateTime("now", input.now);
            const ttlMs = validateTtl(input.ttlMs);
            const owner = validateAgent(input.agent);
            const project = canonicalProject(input.project);
            const role = roleName(input.role);
            const policyDigest = boundedText("policy digest", input.policyDigest, 256);
            database.prepare("DELETE FROM leases WHERE expires_at <= ?").run(now);
            const existingRow = optionalRowFrom(
              database.prepare("SELECT * FROM leases WHERE project = ? AND role = ?").get(project, role),
            );
            if (existingRow) {
              const existing = leaseFromRow(existingRow);
              if (existing.expiresAt > now) return { outcome: "already_owned", lease: existing };
              database.prepare("DELETE FROM leases WHERE project = ? AND role = ?").run(project, role);
            }
            if (count(database, "leases") >= MAX_LEASES) throw registryError("capacity", "lease capacity reached");
            const lease: Lease = {
              id: randomUUID(),
              project,
              role,
              mode: input.mode,
              owner,
              policyDigest,
              acquiredAt: now,
              heartbeatAt: now,
              expiresAt: expiresAt(now, ttlMs),
              status: "active",
            };
            database
              .prepare(`INSERT INTO leases (
                project, role, lease_id, mode, owner_id, owner_pid, owner_model,
                policy_digest, acquired_at, heartbeat_at, expires_at, status, reason
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
              .run(
                lease.project,
                lease.role,
                lease.id,
                lease.mode,
                lease.owner.id,
                lease.owner.pid,
                lease.owner.model ?? null,
                lease.policyDigest,
                lease.acquiredAt,
                lease.heartbeatAt,
                lease.expiresAt,
                lease.status,
              );
            return { outcome: "claimed", lease };
          }),
        ),
      ),

    heartbeat: (input: HeartbeatInput) =>
      effect("Could not heartbeat lease", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): Lease => {
            const now = validateTime("now", input.now);
            const ttlMs = validateTtl(input.ttlMs);
            const policyDigest = boundedText("policy digest", input.policyDigest, 256);
            const row = optionalRowFrom(database.prepare("SELECT * FROM leases WHERE lease_id = ?").get(input.leaseId));
            if (!row) throw registryError("stale_lease", "stale or invalid lease owner");
            const lease = leaseFromRow(row);
            if (lease.owner.id !== input.agentId || lease.expiresAt <= now) {
              throw registryError("stale_lease", "stale or invalid lease owner");
            }
            const status = lease.policyDigest === policyDigest && lease.status !== "suspended" ? lease.status : "suspended";
            const reason = status === "suspended" ? "policy_changed" : null;
            const expiration = expiresAt(now, ttlMs);
            database
              .prepare("UPDATE leases SET heartbeat_at = ?, expires_at = ?, status = ?, reason = ? WHERE lease_id = ?")
              .run(now, expiration, status, reason, lease.id);
            return status === "suspended"
              ? { ...lease, heartbeatAt: now, expiresAt: expiration, status, reason: "policy_changed" }
              : { ...lease, heartbeatAt: now, expiresAt: expiration, status };
          }),
        ),
      ),

    pause: (input: PauseLeaseInput) =>
      effect("Could not pause lease", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): Lease => {
            const now = validateTime("now", input.now);
            const row = optionalRowFrom(database.prepare("SELECT * FROM leases WHERE lease_id = ?").get(input.leaseId));
            if (!row) throw registryError("stale_lease", "stale or invalid lease owner");
            const lease = leaseFromRow(row);
            if (lease.owner.id !== input.agentId || lease.expiresAt <= now || lease.status === "suspended") {
              throw registryError("stale_lease", "stale or invalid lease owner");
            }
            database.prepare("UPDATE leases SET status = 'paused' WHERE lease_id = ?").run(lease.id);
            return { ...lease, status: "paused" };
          }),
        ),
      ),

    resume: (input: HeartbeatInput) =>
      effect("Could not resume lease", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): Lease => {
            const now = validateTime("now", input.now);
            const ttlMs = validateTtl(input.ttlMs);
            const policyDigest = boundedText("policy digest", input.policyDigest, 256);
            const row = optionalRowFrom(database.prepare("SELECT * FROM leases WHERE lease_id = ?").get(input.leaseId));
            if (!row) throw registryError("stale_lease", "stale or invalid lease owner");
            const lease = leaseFromRow(row);
            if (
              lease.owner.id !== input.agentId ||
              lease.expiresAt <= now ||
              lease.status !== "paused" ||
              lease.policyDigest !== policyDigest
            ) {
              throw registryError("stale_lease", "paused lease cannot resume under this owner or policy");
            }
            const expiration = expiresAt(now, ttlMs);
            database
              .prepare("UPDATE leases SET heartbeat_at = ?, expires_at = ?, status = 'active', reason = NULL WHERE lease_id = ?")
              .run(now, expiration, lease.id);
            return { ...lease, heartbeatAt: now, expiresAt: expiration, status: "active" };
          }),
        ),
      ),

    release: (input: ReleaseLeaseInput) =>
      effect("Could not release lease", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, () => {
            validateTime("now", input.now);
            const result = database
              .prepare("DELETE FROM leases WHERE lease_id = ? AND owner_id = ?")
              .run(input.leaseId, input.agentId);
            if (Number(result.changes) !== 1) throw registryError("stale_lease", "stale or invalid lease owner");
          }),
        ),
      ),

    enqueue: (input: EnqueueRequestInput) =>
      effect("Could not queue request", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): RegistryRequest => {
            if (count(database, "requests") >= MAX_REQUESTS) throw registryError("capacity", "request capacity reached");
            const now = validateTime("now", input.now);
            const request: RegistryRequest = {
              id: randomUUID(),
              project: canonicalProject(input.project),
              role: roleName(input.role),
              requesterId: boundedText("requester id", input.requesterId, 128),
              ...(input.requesterLabel ? { requesterLabel: boundedText("requester label", input.requesterLabel, 160) } : {}),
              ...(input.requesterCwd ? { requesterCwd: canonicalProject(input.requesterCwd) } : {}),
              text: persistedText("request", input.text, MAX_REQUEST_TEXT),
              createdAt: now,
              updatedAt: now,
              status: "queued",
            };
            database
              .prepare("INSERT INTO requests (request_id, project, role, requester_id, requester_label, requester_cwd, text, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(
                request.id,
                request.project,
                request.role,
                request.requesterId,
                request.requesterLabel ?? null,
                request.requesterCwd ?? null,
                request.text,
                request.createdAt,
                request.updatedAt,
                request.status,
              );
            return request;
          }),
        ),
      ),

    acknowledgeRequest: (input: AcknowledgeRequestInput) =>
      effect("Could not acknowledge request", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): RegistryRequest => {
            const now = validateTime("now", input.now);
            const request = requestFromRow(requestRow(database, input.requestId));
            if (request.requesterId !== input.requesterId) {
              throw registryError("invalid_transition", "only the requester can acknowledge this request");
            }
            if (request.status !== "completed" && request.status !== "failed" && request.status !== "cancelled") {
              throw registryError("invalid_transition", "only terminal requests can be acknowledged");
            }
            database
              .prepare("UPDATE requests SET requester_acknowledged_at = ? WHERE request_id = ?")
              .run(now, request.id);
            return { ...request, requesterAcknowledgedAt: now };
          }),
        ),
      ),

    cancelRequest: (input: CancelRequestInput) =>
      effect("Could not cancel request", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): RegistryRequest => {
            const now = validateTime("now", input.now);
            const request = requestFromRow(requestRow(database, input.requestId));
            if (request.requesterId !== input.requesterId) {
              throw registryError("invalid_transition", "only the requester can cancel this request");
            }
            if (request.status === "completed" || request.status === "failed" || request.status === "cancelled") {
              throw registryError("invalid_transition", "request is already terminal");
            }
            const result = database
              .prepare("UPDATE requests SET status = 'cancelled', updated_at = ? WHERE request_id = ? AND status IN ('queued', 'claimed')")
              .run(now, request.id);
            if (Number(result.changes) !== 1) throw registryError("invalid_transition", "request terminal transition lost race");
            return { ...request, status: "cancelled", updatedAt: now };
          }),
        ),
      ),

    claimRequest: (input: ClaimRequestInput) =>
      effect("Could not claim request", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): RegistryRequest => {
            const now = validateTime("now", input.now);
            const lease = currentLease(database, input.leaseId, input.agentId, now);
            const request = requestFromRow(requestRow(database, input.requestId));
            if (request.project !== lease.project || request.role !== lease.role) {
              throw registryError("stale_lease", "lease does not own the request role");
            }
            if (request.status === "claimed") {
              const prior = database.prepare("SELECT * FROM leases WHERE lease_id = ? AND expires_at > ?").get(request.leaseId, now);
              if (prior) throw registryError("invalid_transition", "request is already claimed by a live lease");
            } else if (request.status !== "queued") {
              throw registryError("invalid_transition", "request is not claimable");
            }
            database
              .prepare("UPDATE requests SET status = 'claimed', lease_id = ?, agent_id = ?, updated_at = ?, summary = NULL, failure = NULL, diagnostic = NULL WHERE request_id = ?")
              .run(lease.id, lease.owner.id, now, request.id);
            return { ...request, status: "claimed", leaseId: lease.id, agentId: lease.owner.id, updatedAt: now };
          }),
        ),
      ),

    completeRequest: (input: CompleteRequestInput) =>
      effect("Could not complete request", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): RegistryRequest => {
            const now = validateTime("now", input.now);
            const lease = currentLease(database, input.leaseId, input.agentId, now);
            const request = requestFromRow(requestRow(database, input.requestId));
            if (request.status !== "claimed" || request.leaseId !== lease.id || request.agentId !== lease.owner.id) {
              throw registryError("invalid_transition", "request is not claimed by this lease");
            }
            const summary = persistedText("summary", input.summary, MAX_SUMMARY_TEXT);
            const result = database
              .prepare("UPDATE requests SET status = 'completed', summary = ?, updated_at = ? WHERE request_id = ? AND status = 'claimed' AND lease_id = ?")
              .run(summary, now, request.id, lease.id);
            if (Number(result.changes) !== 1) throw registryError("invalid_transition", "request terminal transition lost race");
            return { ...request, status: "completed", summary, updatedAt: now };
          }),
        ),
      ),

    failRequest: (input: FailRequestInput) =>
      effect("Could not fail request", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): RegistryRequest => {
            const now = validateTime("now", input.now);
            const lease = currentLease(database, input.leaseId, input.agentId, now);
            const request = requestFromRow(requestRow(database, input.requestId));
            if (request.status !== "claimed" || request.leaseId !== lease.id || request.agentId !== lease.owner.id) {
              throw registryError("invalid_transition", "request is not claimed by this lease");
            }
            const diagnostic = persistedText("diagnostic", input.diagnostic, MAX_SUMMARY_TEXT);
            const result = database
              .prepare("UPDATE requests SET status = 'failed', failure = ?, diagnostic = ?, updated_at = ? WHERE request_id = ? AND status = 'claimed' AND lease_id = ?")
              .run(input.failure, diagnostic, now, request.id, lease.id);
            if (Number(result.changes) !== 1) throw registryError("invalid_transition", "request terminal transition lost race");
            return { ...request, status: "failed", failure: input.failure, diagnostic, updatedAt: now };
          }),
        ),
      ),
  };
};
