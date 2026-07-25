import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  RegistryError,
  type AcknowledgeRequestInput,
  type AgentHeartbeatInput,
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
  type RegisteredAgent,
  type RegistryRequest,
  type RegistrySnapshot,
  type RegistryStore,
  type ReleaseLeaseInput,
} from "./registry.ts";

// Source-identity columns are an additive v2 extension so sessions still running
// the v2 adapter can coexist during rolling Pi reloads.
const SCHEMA_VERSION = 2;
const MAX_LEASES = 1_024;
const MAX_REQUESTS = 10_000;
const MAX_REQUEST_TEXT = 8_000;
const MAX_SUMMARY_TEXT = 4_000;
const BUSY_TIMEOUT_MS = 2_000;
const SENSITIVE_TEXT =
  /(^|[\\/\s'"])(?:\.env(?:\.[^\\/\s'"]*)?|credentials\.json|secrets\.(?:json|ya?ml)|auth\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/\s'"]+\.(?:key|pem|p12|pfx))($|[\\/\s'"])/i;
const SQL_JSONPATH_DOT_QUOTED_KEY = /\."(?:[^"\\]|\\.)*"/g;
const containsSensitiveText = (text: string): boolean =>
  SENSITIVE_TEXT.test(text.replace(SQL_JSONPATH_DOT_QUOTED_KEY, "$.[json-key]"));

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
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  const busy = /busy|locked/i.test(message) || /BUSY|LOCKED/i.test(code);
  const knownCause = [
    /database is (?:busy|locked)/i,
    /disk I\/O error/i,
    /database disk image is malformed/i,
    /unable to open database file/i,
    /readonly database/i,
  ].find((pattern) => pattern.test(message));
  const cause = knownCause ? message.match(knownCause)?.[0] : code && /^ERR_SQLITE_[A-Z_]+$/.test(code) ? code : undefined;
  return registryError(busy ? "busy" : "io", cause ? `${fallback}: ${cause}` : fallback);
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
  if (containsSensitiveText(bounded)) {
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

const validateRuntimeVersions = (
  runtimeVersions: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (runtimeVersions === undefined) return undefined;
  const entries = Object.entries(runtimeVersions);
  if (entries.length > 32) throw registryError("invalid_input", "runtime versions exceed component limit");
  const validated = entries.map(([component, version]) => [
    boundedText("runtime component", component, 64),
    boundedText("runtime version", version, 128),
  ] as const);
  return Object.fromEntries(validated.sort(([left], [right]) => left.localeCompare(right)));
};

const validateAgent: (agent: AgentIdentity) => AgentIdentity = (agent) => {
  const id = boundedText("agent id", agent.id, 128);
  if (!Number.isSafeInteger(agent.pid) || agent.pid < 1) throw registryError("invalid_input", "pid must be positive");
  const model = agent.model ? boundedText("model", agent.model, 256) : undefined;
  const runtimeVersions = validateRuntimeVersions(agent.runtimeVersions);
  return { id, pid: agent.pid, ...(model ? { model } : {}), ...(runtimeVersions ? { runtimeVersions } : {}) };
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

const runtimeVersionsFromRow = (row: Row): Readonly<Record<string, string>> | undefined => {
  const encoded = stringField(row, "runtime_versions", true);
  if (!encoded) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw registryError("corrupt_state", "registry runtime versions are malformed JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw registryError("corrupt_state", "registry runtime versions are malformed");
  }
  const entries = Object.entries(decoded);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw registryError("corrupt_state", "registry runtime version value is malformed");
  }
  return validateRuntimeVersions(Object.fromEntries(entries));
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
  const runtimeVersions = runtimeVersionsFromRow(row);
  const owner: AgentIdentity = {
    id: stringField(row, "owner_id") ?? "",
    pid: numberField(row, "owner_pid"),
    ...(stringField(row, "owner_model", true) ? { model: stringField(row, "owner_model", true) } : {}),
    ...(runtimeVersions ? { runtimeVersions } : {}),
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

const registeredAgentFromRow = (row: Row): RegisteredAgent => {
  const runtimeVersions = runtimeVersionsFromRow(row);
  return {
    identity: {
      id: stringField(row, "agent_id") ?? "",
      pid: numberField(row, "pid"),
      ...(stringField(row, "model", true) ? { model: stringField(row, "model", true) } : {}),
      ...(runtimeVersions ? { runtimeVersions } : {}),
    },
    cwd: stringField(row, "cwd") ?? "",
    label: stringField(row, "label") ?? "",
    heartbeatAt: numberField(row, "heartbeat_at"),
    expiresAt: numberField(row, "expires_at"),
  };
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

const tableColumns = (database: DatabaseSync, table: string): ReadonlySet<string> =>
  new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => stringField(rowFrom(row), "name") ?? ""));

const currentAdditiveSchemaInstalled = (database: DatabaseSync): boolean => {
  const requests = tableColumns(database, "requests");
  const leases = tableColumns(database, "leases");
  const agents = tableColumns(database, "agents");
  return (
    ["requester_acknowledged_at", "requester_label", "requester_cwd"].every((column) => requests.has(column)) &&
    leases.has("runtime_versions") &&
    ["agent_id", "runtime_versions", "cwd", "label", "expires_at"].every((column) => agents.has(column))
  );
};

const initialize: (database: DatabaseSync, databasePath: string) => void = (database, databasePath) => {
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  const journalMode = stringField(rowFrom(database.prepare("PRAGMA journal_mode").get()), "journal_mode");
  if (journalMode.toLowerCase() !== "wal") {
    try {
      database.prepare("PRAGMA journal_mode = WAL").get();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/busy|locked/i.test(message)) throw error;
      // A concurrent first opener may be installing WAL. This connection can
      // safely continue under the observed mode; a later opener verifies WAL.
    }
  }
  database.exec("PRAGMA synchronous = NORMAL;");
  const observedVersion = schemaVersion(database);
  if (observedVersion === SCHEMA_VERSION && currentAdditiveSchemaInstalled(database)) return;
  if (observedVersion !== 0 && observedVersion !== 1 && observedVersion !== 2 && observedVersion !== 3) {
    throw registryError("corrupt_state", `unsupported agent registry schema version ${observedVersion}`);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const currentVersion = schemaVersion(database);
    if (currentVersion === 0) {
      database.exec(`
        CREATE TABLE agents (
          agent_id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          model TEXT,
          runtime_versions TEXT,
          cwd TEXT NOT NULL,
          label TEXT NOT NULL,
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
    } else {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          model TEXT,
          runtime_versions TEXT,
          cwd TEXT NOT NULL,
          label TEXT NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
      `);
      const columns = new Set(
        database.prepare("PRAGMA table_info(requests)").all().map((row) => stringField(rowFrom(row), "name")),
      );
      const addColumn = (name: string, declaration: string) => {
        if (columns.has(name)) return;
        database.exec(`ALTER TABLE requests ADD COLUMN ${declaration};`);
        columns.add(name);
      };
      const leaseColumns = new Set(
        database.prepare("PRAGMA table_info(leases)").all().map((row) => stringField(rowFrom(row), "name")),
      );
      if (!leaseColumns.has("runtime_versions")) {
        database.exec("ALTER TABLE leases ADD COLUMN runtime_versions TEXT;");
      }
      if (currentVersion === 1) addColumn("requester_acknowledged_at", "requester_acknowledged_at INTEGER");
      addColumn("requester_label", "requester_label TEXT");
      addColumn("requester_cwd", "requester_cwd TEXT");
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
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
          agents: rowsFrom(database.prepare("SELECT * FROM agents WHERE expires_at > ? ORDER BY label, agent_id").all(timestamp)).map(registeredAgentFromRow),
          leases: rowsFrom(database.prepare("SELECT * FROM leases WHERE expires_at > ? ORDER BY project, role").all(timestamp)).map(leaseFromRow),
          requests: rowsFrom(database.prepare("SELECT * FROM requests ORDER BY created_at, request_id").all()).map(requestFromRow),
        }));
      }),

    heartbeatAgent: (input: AgentHeartbeatInput) =>
      effect("Could not heartbeat agent presence", () =>
        withDatabase(databasePath, (database) =>
          transaction(database, (): RegisteredAgent => {
            const now = validateTime("now", input.now);
            const ttlMs = validateTtl(input.ttlMs);
            const identity = validateAgent(input.agent);
            const cwd = canonicalProject(input.cwd);
            const label = boundedText("agent label", input.label, 160);
            const agent: RegisteredAgent = {
              identity,
              cwd,
              label,
              heartbeatAt: now,
              expiresAt: expiresAt(now, ttlMs),
            };
            database.prepare("DELETE FROM agents WHERE expires_at <= ?").run(now);
            database
              .prepare(`INSERT INTO agents (
                agent_id, pid, model, runtime_versions, cwd, label, heartbeat_at, expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(agent_id) DO UPDATE SET
                pid = excluded.pid,
                model = excluded.model,
                runtime_versions = excluded.runtime_versions,
                cwd = excluded.cwd,
                label = excluded.label,
                heartbeat_at = excluded.heartbeat_at,
                expires_at = excluded.expires_at`)
              .run(
                identity.id,
                identity.pid,
                identity.model ?? null,
                identity.runtimeVersions ? JSON.stringify(identity.runtimeVersions) : null,
                cwd,
                label,
                agent.heartbeatAt,
                agent.expiresAt,
              );
            return agent;
          }),
        ),
      ),

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
                project, role, lease_id, mode, owner_id, owner_pid, owner_model, runtime_versions,
                policy_digest, acquired_at, heartbeat_at, expires_at, status, reason
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
              .run(
                lease.project,
                lease.role,
                lease.id,
                lease.mode,
                lease.owner.id,
                lease.owner.pid,
                lease.owner.model ?? null,
                lease.owner.runtimeVersions ? JSON.stringify(lease.owner.runtimeVersions) : null,
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
            const runtimeVersions = validateRuntimeVersions(input.runtimeVersions);
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
              .prepare("UPDATE leases SET heartbeat_at = ?, expires_at = ?, status = ?, reason = ?, runtime_versions = ? WHERE lease_id = ?")
              .run(
                now,
                expiration,
                status,
                reason,
                runtimeVersions ? JSON.stringify(runtimeVersions) : null,
                lease.id,
              );
            const owner = { ...lease.owner, ...(runtimeVersions ? { runtimeVersions } : {}) };
            return status === "suspended"
              ? { ...lease, owner, heartbeatAt: now, expiresAt: expiration, status, reason: "policy_changed" }
              : { ...lease, owner, heartbeatAt: now, expiresAt: expiration, status };
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
            const runtimeVersions = validateRuntimeVersions(input.runtimeVersions);
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
              .prepare("UPDATE leases SET heartbeat_at = ?, expires_at = ?, status = 'active', reason = NULL, runtime_versions = ? WHERE lease_id = ?")
              .run(now, expiration, runtimeVersions ? JSON.stringify(runtimeVersions) : null, lease.id);
            const owner = { ...lease.owner, ...(runtimeVersions ? { runtimeVersions } : {}) };
            return { ...lease, owner, heartbeatAt: now, expiresAt: expiration, status: "active" };
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
