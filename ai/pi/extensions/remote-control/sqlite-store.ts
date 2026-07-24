import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  BRIDGE_MESSAGE_TTL_MS,
  BRIDGE_PROTOCOL_VERSION,
  MAX_REMOTE_MESSAGE_CHARACTERS,
  MAX_REMOTE_RESPONSE_CHARACTERS,
  RemoteBridgeError,
  boundedBridgeText,
  boundedIdentifier,
  boundedTimestamp,
  boundedTtl,
  type BridgeAgent,
  type RemoteFailure,
  type RemoteMessage,
} from "./protocol.ts";

const BUSY_TIMEOUT_MS = 2_000;
const MAX_AGENTS = 1_024;
const MAX_MESSAGES = 10_000;

type Row = Readonly<Record<string, unknown>>;

export interface HeartbeatBridgeAgentInput {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly accepting: boolean;
  readonly now: number;
  readonly ttlMs: number;
}

export interface EnqueueRemoteMessageInput {
  readonly targetAgentId: string;
  readonly requesterId: string;
  readonly dedupeKey: string;
  readonly text: string;
  readonly now: number;
  readonly ttlMs: number;
}

export interface ClaimRemoteMessageInput {
  readonly agentId: string;
  readonly now: number;
}

export interface FinishRemoteMessageInput {
  readonly messageId: string;
  readonly claimToken: string;
  readonly now: number;
}

export interface RemoteBridgeStore {
  readonly heartbeatAgent: (input: HeartbeatBridgeAgentInput) => Effect.Effect<BridgeAgent, RemoteBridgeError>;
  readonly listAgents: (now: number) => Effect.Effect<readonly BridgeAgent[], RemoteBridgeError>;
  readonly enqueue: (input: EnqueueRemoteMessageInput) => Effect.Effect<RemoteMessage, RemoteBridgeError>;
  readonly claimNext: (input: ClaimRemoteMessageInput) => Effect.Effect<RemoteMessage | undefined, RemoteBridgeError>;
  readonly complete: (
    input: FinishRemoteMessageInput & { readonly response: string },
  ) => Effect.Effect<RemoteMessage, RemoteBridgeError>;
  readonly fail: (
    input: FinishRemoteMessageInput & { readonly failure: RemoteFailure },
  ) => Effect.Effect<RemoteMessage, RemoteBridgeError>;
  readonly get: (messageId: string, now: number) => Effect.Effect<RemoteMessage, RemoteBridgeError>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<boolean, RemoteBridgeError>;
  readonly isEnabled: () => Effect.Effect<boolean, RemoteBridgeError>;
}

const bridgeError = (code: RemoteBridgeError["code"], message: string): RemoteBridgeError =>
  new RemoteBridgeError({ code, message });

const asBridgeError = (error: unknown, fallback: string): RemoteBridgeError => {
  if (error instanceof RemoteBridgeError) return error;
  const message = error instanceof Error ? error.message : "";
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (/busy|locked/i.test(message) || /BUSY|LOCKED/i.test(code)) return bridgeError("busy", `${fallback}: busy`);
  return bridgeError("io", fallback);
};

const attempt = <T>(fallback: string, operation: () => T): Effect.Effect<T, RemoteBridgeError> =>
  Effect.try({ try: operation, catch: (error) => asBridgeError(error, fallback) });

const rowFrom = (value: unknown): Row => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bridgeError("corrupt_state", "bridge query returned a malformed row");
  }
  return value;
};

const optionalRowFrom = (value: unknown): Row | undefined => (value === undefined ? undefined : rowFrom(value));

const stringField = (row: Row, key: string, optional = false): string | undefined => {
  const value = row[key];
  if (optional && value === null) return undefined;
  if (typeof value !== "string") throw bridgeError("corrupt_state", `bridge column ${key} is malformed`);
  return value;
};

const numberField = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw bridgeError("corrupt_state", `bridge column ${key} is malformed`);
  }
  return value;
};

const booleanField = (row: Row, key: string): boolean => {
  const value = numberField(row, key);
  if (value !== 0 && value !== 1) throw bridgeError("corrupt_state", `bridge column ${key} is malformed`);
  return value === 1;
};

const agentFromRow = (row: Row): BridgeAgent => ({
  id: stringField(row, "agent_id") ?? "",
  label: stringField(row, "label") ?? "",
  cwd: stringField(row, "cwd") ?? "",
  heartbeatAt: numberField(row, "heartbeat_at"),
  expiresAt: numberField(row, "expires_at"),
  accepting: booleanField(row, "accepting"),
});

const messageFromRow = (row: Row): RemoteMessage => {
  const status = stringField(row, "status");
  const base = {
    id: stringField(row, "message_id") ?? "",
    targetAgentId: stringField(row, "target_agent_id") ?? "",
    requesterId: stringField(row, "requester_id") ?? "",
    dedupeKey: stringField(row, "dedupe_key") ?? "",
    text: stringField(row, "text") ?? "",
    createdAt: numberField(row, "created_at"),
    expiresAt: numberField(row, "expires_at"),
    updatedAt: numberField(row, "updated_at"),
  };
  if (status === "queued") return { ...base, status };
  if (status === "claimed") {
    return {
      ...base,
      status,
      claimToken: stringField(row, "claim_token") ?? "",
      claimedAt: numberField(row, "claimed_at"),
    };
  }
  if (status === "completed") {
    return {
      ...base,
      status,
      response: stringField(row, "response") ?? "",
      completedAt: numberField(row, "completed_at"),
    };
  }
  if (status === "failed") {
    const failure = stringField(row, "failure");
    if (
      failure !== "aborted" &&
      failure !== "bridge_disabled" &&
      failure !== "expired" &&
      failure !== "model_error" &&
      failure !== "session_ended"
    ) {
      throw bridgeError("corrupt_state", "bridge failure is malformed");
    }
    return { ...base, status, failure, completedAt: numberField(row, "completed_at") };
  }
  throw bridgeError("corrupt_state", "bridge message status is malformed");
};

const initialize = (database: DatabaseSync): void => {
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  database.prepare("PRAGMA journal_mode = WAL").get();
  database.exec("PRAGMA synchronous = NORMAL;");
  const version = numberField(rowFrom(database.prepare("PRAGMA user_version").get()), "user_version");
  if (version !== 0 && version !== BRIDGE_PROTOCOL_VERSION) {
    throw bridgeError("corrupt_state", `unsupported bridge protocol version ${version}`);
  }
  if (version === BRIDGE_PROTOCOL_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE bridge_agents (
        agent_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        cwd TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepting INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE bridge_messages (
        message_id TEXT PRIMARY KEY,
        target_agent_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        claim_token TEXT,
        claimed_at INTEGER,
        response TEXT,
        failure TEXT,
        completed_at INTEGER,
        UNIQUE (requester_id, dedupe_key)
      ) STRICT;
      CREATE INDEX bridge_messages_target_status
        ON bridge_messages (target_agent_id, status, created_at);
      CREATE TABLE bridge_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO bridge_settings (key, value) VALUES ('enabled', '1');
      PRAGMA user_version = ${BRIDGE_PROTOCOL_VERSION};
    `);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
};

const withDatabase = <T>(databasePath: string, use: (database: DatabaseSync) => T): T => {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const database = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  try {
    initialize(database);
    return use(database);
  } finally {
    database.close();
  }
};

const transaction = <T>(database: DatabaseSync, mutate: () => T): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = mutate();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
};

const count = (database: DatabaseSync, table: "bridge_agents" | "bridge_messages"): number =>
  numberField(rowFrom(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()), "count");

const enabled = (database: DatabaseSync): boolean => {
  const row = optionalRowFrom(database.prepare("SELECT value FROM bridge_settings WHERE key = 'enabled'").get());
  if (!row) throw bridgeError("corrupt_state", "bridge enabled setting is missing");
  const value = stringField(row, "value");
  if (value !== "0" && value !== "1") throw bridgeError("corrupt_state", "bridge enabled setting is malformed");
  return value === "1";
};

const expireMessages = (database: DatabaseSync, now: number): void => {
  database
    .prepare(
      `UPDATE bridge_messages
       SET status = 'failed', failure = 'expired', completed_at = ?, updated_at = ?, claim_token = NULL
       WHERE status IN ('queued', 'claimed') AND expires_at <= ?`,
    )
    .run(now, now, now);
};

const pruneTerminalMessages = (database: DatabaseSync, now: number): void => {
  database
    .prepare("DELETE FROM bridge_messages WHERE status IN ('completed', 'failed') AND updated_at <= ?")
    .run(Math.max(0, now - BRIDGE_MESSAGE_TTL_MS));
};

export const makeRemoteBridgeStore = (databasePath: string): RemoteBridgeStore => ({
  heartbeatAgent: (input) =>
    attempt("Could not heartbeat bridge agent", () =>
      withDatabase(databasePath, (database) => {
        const id = boundedIdentifier("agent id", input.id);
        const label = boundedBridgeText("agent label", input.label, 256);
        const cwd = boundedBridgeText("agent cwd", input.cwd, 1_024);
        const now = boundedTimestamp("now", input.now);
        const ttlMs = boundedTtl(input.ttlMs);
        const expiresAt = now + ttlMs;
        if (!Number.isSafeInteger(expiresAt)) throw bridgeError("invalid_input", "agent expiry exceeds time range");
        return transaction(database, () => {
          database.prepare("DELETE FROM bridge_agents WHERE expires_at <= ?").run(now);
          if (count(database, "bridge_agents") >= MAX_AGENTS) {
            const exists = database.prepare("SELECT 1 FROM bridge_agents WHERE agent_id = ?").get(id);
            if (!exists) throw bridgeError("capacity", "bridge agent capacity reached");
          }
          database
            .prepare(
              `INSERT INTO bridge_agents (agent_id, label, cwd, heartbeat_at, expires_at, accepting)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(agent_id) DO UPDATE SET
                 label = excluded.label,
                 cwd = excluded.cwd,
                 heartbeat_at = excluded.heartbeat_at,
                 expires_at = excluded.expires_at,
                 accepting = excluded.accepting`,
            )
            .run(id, label, cwd, now, expiresAt, input.accepting ? 1 : 0);
          return agentFromRow(rowFrom(database.prepare("SELECT * FROM bridge_agents WHERE agent_id = ?").get(id)));
        });
      }),
    ),
  listAgents: (now) =>
    attempt("Could not list bridge agents", () =>
      withDatabase(databasePath, (database) => {
        const at = boundedTimestamp("now", now);
        database.prepare("DELETE FROM bridge_agents WHERE expires_at <= ?").run(at);
        return database
          .prepare("SELECT * FROM bridge_agents WHERE expires_at > ? ORDER BY label, agent_id")
          .all(at)
          .map((row) => agentFromRow(rowFrom(row)));
      }),
    ),
  enqueue: (input) =>
    attempt("Could not enqueue remote message", () =>
      withDatabase(databasePath, (database) => {
        const targetAgentId = boundedIdentifier("target agent id", input.targetAgentId);
        const requesterId = boundedIdentifier("requester id", input.requesterId);
        const dedupeKey = boundedIdentifier("dedupe key", input.dedupeKey, 256);
        const text = boundedBridgeText("message", input.text, MAX_REMOTE_MESSAGE_CHARACTERS);
        const now = boundedTimestamp("now", input.now);
        const ttlMs = boundedTtl(input.ttlMs);
        const expiresAt = now + ttlMs;
        if (!Number.isSafeInteger(expiresAt)) throw bridgeError("invalid_input", "message expiry exceeds time range");
        return transaction(database, () => {
          expireMessages(database, now);
          pruneTerminalMessages(database, now);
          if (!enabled(database)) throw bridgeError("disabled", "remote message bridge is disabled");
          const agent = optionalRowFrom(
            database.prepare("SELECT * FROM bridge_agents WHERE agent_id = ? AND expires_at > ?").get(targetAgentId, now),
          );
          if (!agent) throw bridgeError("stale_agent", "target session is not bridge-ready");
          const existing = optionalRowFrom(
            database
              .prepare("SELECT * FROM bridge_messages WHERE requester_id = ? AND dedupe_key = ?")
              .get(requesterId, dedupeKey),
          );
          if (existing) return messageFromRow(existing);
          if (count(database, "bridge_messages") >= MAX_MESSAGES) {
            throw bridgeError("capacity", "bridge message capacity reached");
          }
          const id = randomUUID();
          database
            .prepare(
              `INSERT INTO bridge_messages (
                 message_id, target_agent_id, requester_id, dedupe_key, text,
                 created_at, expires_at, updated_at, status
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
            )
            .run(id, targetAgentId, requesterId, dedupeKey, text, now, expiresAt, now);
          return messageFromRow(rowFrom(database.prepare("SELECT * FROM bridge_messages WHERE message_id = ?").get(id)));
        });
      }),
    ),
  claimNext: (input) =>
    attempt("Could not claim remote message", () =>
      withDatabase(databasePath, (database) => {
        const agentId = boundedIdentifier("agent id", input.agentId);
        const now = boundedTimestamp("now", input.now);
        return transaction(database, () => {
          expireMessages(database, now);
          if (!enabled(database)) return undefined;
          const row = optionalRowFrom(
            database
              .prepare(
                `SELECT * FROM bridge_messages
                 WHERE target_agent_id = ? AND status = 'queued' AND expires_at > ?
                 ORDER BY created_at, message_id LIMIT 1`,
              )
              .get(agentId, now),
          );
          if (!row) return undefined;
          const id = stringField(row, "message_id") ?? "";
          const claimToken = randomUUID();
          database
            .prepare(
              `UPDATE bridge_messages
               SET status = 'claimed', claim_token = ?, claimed_at = ?, updated_at = ?
               WHERE message_id = ? AND status = 'queued'`,
            )
            .run(claimToken, now, now, id);
          return messageFromRow(rowFrom(database.prepare("SELECT * FROM bridge_messages WHERE message_id = ?").get(id)));
        });
      }),
    ),
  complete: (input) =>
    attempt("Could not complete remote message", () =>
      withDatabase(databasePath, (database) => {
        const messageId = boundedIdentifier("message id", input.messageId);
        const claimToken = boundedIdentifier("claim token", input.claimToken);
        const response = boundedBridgeText("response", input.response, MAX_REMOTE_RESPONSE_CHARACTERS);
        const now = boundedTimestamp("now", input.now);
        return transaction(database, () => {
          const result = database
            .prepare(
              `UPDATE bridge_messages
               SET status = 'completed', response = ?, completed_at = ?, updated_at = ?, claim_token = NULL
               WHERE message_id = ? AND status = 'claimed' AND claim_token = ? AND expires_at > ?`,
            )
            .run(response, now, now, messageId, claimToken, now);
          if (result.changes !== 1) throw bridgeError("invalid_transition", "stale remote message claim");
          return messageFromRow(
            rowFrom(database.prepare("SELECT * FROM bridge_messages WHERE message_id = ?").get(messageId)),
          );
        });
      }),
    ),
  fail: (input) =>
    attempt("Could not fail remote message", () =>
      withDatabase(databasePath, (database) => {
        const messageId = boundedIdentifier("message id", input.messageId);
        const claimToken = boundedIdentifier("claim token", input.claimToken);
        const now = boundedTimestamp("now", input.now);
        return transaction(database, () => {
          const result = database
            .prepare(
              `UPDATE bridge_messages
               SET status = 'failed', failure = ?, completed_at = ?, updated_at = ?, claim_token = NULL
               WHERE message_id = ? AND status = 'claimed' AND claim_token = ?`,
            )
            .run(input.failure, now, now, messageId, claimToken);
          if (result.changes !== 1) throw bridgeError("invalid_transition", "stale remote message claim");
          return messageFromRow(
            rowFrom(database.prepare("SELECT * FROM bridge_messages WHERE message_id = ?").get(messageId)),
          );
        });
      }),
    ),
  get: (messageId, now) =>
    attempt("Could not read remote message", () =>
      withDatabase(databasePath, (database) => {
        const id = boundedIdentifier("message id", messageId);
        const at = boundedTimestamp("now", now);
        expireMessages(database, at);
        const row = optionalRowFrom(database.prepare("SELECT * FROM bridge_messages WHERE message_id = ?").get(id));
        if (!row) throw bridgeError("not_found", "remote message not found");
        return messageFromRow(row);
      }),
    ),
  setEnabled: (value) =>
    attempt("Could not update bridge state", () =>
      withDatabase(databasePath, (database) => {
        database.prepare("UPDATE bridge_settings SET value = ? WHERE key = 'enabled'").run(value ? "1" : "0");
        return value;
      }),
    ),
  isEnabled: () => attempt("Could not read bridge state", () => withDatabase(databasePath, enabled)),
});
