import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import {
  BRIDGE_MESSAGE_TTL_MS,
  BRIDGE_PROTOCOL_VERSION,
  MAX_REMOTE_ANSWER_CHARACTERS,
  MAX_REMOTE_MESSAGE_CHARACTERS,
  MAX_REMOTE_QUESTION_CHARACTERS,
  MAX_REMOTE_RESPONSE_CHARACTERS,
  RemoteBridgeError,
  boundedBridgeText,
  boundedIdentifier,
  boundedTimestamp,
  boundedTtl,
  type BridgeAgent,
  type BridgeQuestion,
  type RemoteFailure,
  type RemoteMessage,
  type RemoteQuestionOption,
  type RemoteQuestionResolution,
  type RemoteQuestionSnapshot,
} from "./protocol.ts"

const BUSY_TIMEOUT_MS = 2_000
const MAX_AGENTS = 1_024
const MAX_MESSAGES = 10_000

type Row = Readonly<Record<string, unknown>>

export interface HeartbeatBridgeAgentInput {
  readonly id: string
  readonly label: string
  readonly cwd: string
  readonly accepting: boolean
  readonly now: number
  readonly ttlMs: number
}

export interface EnqueueRemoteMessageInput {
  readonly targetAgentId: string
  readonly requesterId: string
  readonly dedupeKey: string
  readonly text: string
  readonly now: number
  readonly ttlMs: number
}

export interface ClaimRemoteMessageInput {
  readonly agentId: string
  readonly now: number
}

export interface FinishRemoteMessageInput {
  readonly messageId: string
  readonly claimToken: string
  readonly now: number
}

export interface SyncRemoteQuestionsInput {
  readonly agentId: string
  readonly questions: readonly RemoteQuestionSnapshot[]
  readonly now: number
}

export interface LinkTelegramQuestionInput {
  readonly agentId: string
  readonly questionId: number
  readonly chatId: number
  readonly messageId: number
  readonly now: number
}

export interface AnswerTelegramQuestionInput {
  readonly chatId: number
  readonly messageId: number
  readonly answer: string
  readonly now: number
}

export interface TakeQuestionResolutionInput {
  readonly agentId: string
  readonly now: number
}

export interface RemoteBridgeStore {
  readonly heartbeatAgent: (
    input: HeartbeatBridgeAgentInput,
  ) => Effect.Effect<BridgeAgent, RemoteBridgeError>
  readonly listAgents: (
    now: number,
  ) => Effect.Effect<readonly BridgeAgent[], RemoteBridgeError>
  readonly enqueue: (
    input: EnqueueRemoteMessageInput,
  ) => Effect.Effect<RemoteMessage, RemoteBridgeError>
  readonly claimNext: (
    input: ClaimRemoteMessageInput,
  ) => Effect.Effect<RemoteMessage | undefined, RemoteBridgeError>
  readonly complete: (
    input: FinishRemoteMessageInput & { readonly response: string },
  ) => Effect.Effect<RemoteMessage, RemoteBridgeError>
  readonly fail: (
    input: FinishRemoteMessageInput & { readonly failure: RemoteFailure },
  ) => Effect.Effect<RemoteMessage, RemoteBridgeError>
  readonly get: (
    messageId: string,
    now: number,
  ) => Effect.Effect<RemoteMessage, RemoteBridgeError>
  readonly setEnabled: (
    enabled: boolean,
  ) => Effect.Effect<boolean, RemoteBridgeError>
  readonly isEnabled: () => Effect.Effect<boolean, RemoteBridgeError>
  readonly syncQuestions: (
    input: SyncRemoteQuestionsInput,
  ) => Effect.Effect<void, RemoteBridgeError>
  readonly listUnrelayedQuestions: (
    now: number,
  ) => Effect.Effect<readonly BridgeQuestion[], RemoteBridgeError>
  readonly linkTelegramQuestion: (
    input: LinkTelegramQuestionInput,
  ) => Effect.Effect<BridgeQuestion, RemoteBridgeError>
  readonly answerTelegramQuestion: (
    input: AnswerTelegramQuestionInput,
  ) => Effect.Effect<RemoteQuestionResolution, RemoteBridgeError>
  readonly takeQuestionResolution: (
    input: TakeQuestionResolutionInput,
  ) => Effect.Effect<RemoteQuestionResolution | undefined, RemoteBridgeError>
}

const bridgeError = (
  code: RemoteBridgeError["code"],
  message: string,
): RemoteBridgeError => new RemoteBridgeError({ code, message })

const asBridgeError = (error: unknown, fallback: string): RemoteBridgeError => {
  if (error instanceof RemoteBridgeError) return error
  const message = error instanceof Error ? error.message : ""
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : ""
  if (/busy|locked/i.test(message) || /BUSY|LOCKED/i.test(code))
    return bridgeError("busy", `${fallback}: busy`)
  return bridgeError("io", fallback)
}

const attempt = <T>(
  fallback: string,
  operation: () => T,
): Effect.Effect<T, RemoteBridgeError> =>
  Effect.try({
    try: operation,
    catch: (error) => asBridgeError(error, fallback),
  })

const rowFrom = (value: unknown): Row => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bridgeError("corrupt_state", "bridge query returned a malformed row")
  }
  return value
}

const optionalRowFrom = (value: unknown): Row | undefined =>
  value === undefined ? undefined : rowFrom(value)

const stringField = (
  row: Row,
  key: string,
  optional = false,
): string | undefined => {
  const value = row[key]
  if (optional && value === null) return undefined
  if (typeof value !== "string")
    throw bridgeError("corrupt_state", `bridge column ${key} is malformed`)
  return value
}

const numberField = (row: Row, key: string): number => {
  const value = row[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw bridgeError("corrupt_state", `bridge column ${key} is malformed`)
  }
  return value
}

const booleanField = (row: Row, key: string): boolean => {
  const value = numberField(row, key)
  if (value !== 0 && value !== 1)
    throw bridgeError("corrupt_state", `bridge column ${key} is malformed`)
  return value === 1
}

const agentFromRow = (row: Row): BridgeAgent => ({
  id: stringField(row, "agent_id") ?? "",
  label: stringField(row, "label") ?? "",
  cwd: stringField(row, "cwd") ?? "",
  heartbeatAt: numberField(row, "heartbeat_at"),
  expiresAt: numberField(row, "expires_at"),
  accepting: booleanField(row, "accepting"),
})

const messageFromRow = (row: Row): RemoteMessage => {
  const status = stringField(row, "status")
  const base = {
    id: stringField(row, "message_id") ?? "",
    targetAgentId: stringField(row, "target_agent_id") ?? "",
    requesterId: stringField(row, "requester_id") ?? "",
    dedupeKey: stringField(row, "dedupe_key") ?? "",
    text: stringField(row, "text") ?? "",
    createdAt: numberField(row, "created_at"),
    expiresAt: numberField(row, "expires_at"),
    updatedAt: numberField(row, "updated_at"),
  }
  if (status === "queued") return { ...base, status }
  if (status === "claimed") {
    return {
      ...base,
      status,
      claimToken: stringField(row, "claim_token") ?? "",
      claimedAt: numberField(row, "claimed_at"),
    }
  }
  if (status === "completed") {
    return {
      ...base,
      status,
      response: stringField(row, "response") ?? "",
      completedAt: numberField(row, "completed_at"),
    }
  }
  if (status === "failed") {
    const failure = stringField(row, "failure")
    if (
      failure !== "aborted" &&
      failure !== "bridge_disabled" &&
      failure !== "expired" &&
      failure !== "model_error" &&
      failure !== "session_ended"
    ) {
      throw bridgeError("corrupt_state", "bridge failure is malformed")
    }
    return {
      ...base,
      status,
      failure,
      completedAt: numberField(row, "completed_at"),
    }
  }
  throw bridgeError("corrupt_state", "bridge message status is malformed")
}

const positiveSafeInteger = (label: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw bridgeError(
      "invalid_input",
      `${label} must be a positive safe integer`,
    )
  }

  return value
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const questionOptionsFromJson = (
  value: string | undefined,
): readonly RemoteQuestionOption[] | undefined => {
  if (value === undefined) return undefined

  const decodedResult = Effect.runSync(
    Effect.either(
      Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: () =>
          bridgeError("corrupt_state", "bridge question options are malformed"),
      }),
    ),
  )
  if (decodedResult._tag === "Left") throw decodedResult.left
  const decoded = decodedResult.right

  if (
    !Array.isArray(decoded) ||
    decoded.length < 2 ||
    decoded.length > 4 ||
    !decoded.every(
      (option) =>
        isRecord(option) &&
        typeof option.label === "string" &&
        option.label.length > 0 &&
        option.label.length <= 80 &&
        (option.description === undefined ||
          (typeof option.description === "string" &&
            option.description.length <= 160)),
    )
  ) {
    throw bridgeError("corrupt_state", "bridge question options are malformed")
  }

  return decoded as unknown as readonly RemoteQuestionOption[]
}

const questionFromRow = (row: Row): BridgeQuestion => {
  const header = stringField(row, "header", true)
  const guess = stringField(row, "guess", true)
  const options = questionOptionsFromJson(
    stringField(row, "options_json", true),
  )

  return {
    agentId: stringField(row, "agent_id") ?? "",
    questionId: numberField(row, "question_id"),
    question: stringField(row, "question_text") ?? "",
    ...(header ? { header } : {}),
    ...(guess ? { guess } : {}),
    ...(options ? { options } : {}),
    createdAt: numberField(row, "created_at"),
    updatedAt: numberField(row, "updated_at"),
  }
}

const resolutionFromRow = (row: Row): RemoteQuestionResolution => ({
  agentId: stringField(row, "agent_id") ?? "",
  questionId: numberField(row, "question_id"),
  answer: stringField(row, "answer") ?? "",
})

const boundedOptionalText = (
  label: string,
  value: string | undefined,
  maximum: number,
): string | undefined =>
  value === undefined ? undefined : boundedBridgeText(label, value, maximum)

const boundedQuestionSnapshot = (
  question: RemoteQuestionSnapshot,
): RemoteQuestionSnapshot => {
  const options = question.options?.map((option) => ({
    label: boundedBridgeText("question option label", option.label, 80),
    ...(option.description === undefined
      ? {}
      : {
          description: boundedBridgeText(
            "question option description",
            option.description,
            160,
          ),
        }),
  }))
  if (options !== undefined && (options.length < 2 || options.length > 4)) {
    throw bridgeError(
      "invalid_input",
      "question options must contain 2-4 choices",
    )
  }

  return {
    id: positiveSafeInteger("question id", question.id),
    status: question.status,
    question: boundedBridgeText(
      "question",
      question.question,
      MAX_REMOTE_QUESTION_CHARACTERS,
    ),
    ...(boundedOptionalText("question header", question.header, 16)
      ? { header: boundedOptionalText("question header", question.header, 16) }
      : {}),
    ...(boundedOptionalText("question guess", question.guess, 2_000)
      ? { guess: boundedOptionalText("question guess", question.guess, 2_000) }
      : {}),
    ...(options ? { options } : {}),
  }
}

const initialize = (database: DatabaseSync): void => {
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  database.prepare("PRAGMA journal_mode = WAL").get()
  database.exec("PRAGMA synchronous = NORMAL;")
  const version = numberField(
    rowFrom(database.prepare("PRAGMA user_version").get()),
    "user_version",
  )
  if (version < 0 || version > BRIDGE_PROTOCOL_VERSION) {
    throw bridgeError(
      "corrupt_state",
      `unsupported bridge protocol version ${version}`,
    )
  }
  if (version === BRIDGE_PROTOCOL_VERSION) return
  database.exec("BEGIN IMMEDIATE")
  try {
    if (version === 0) {
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
      `)
    }

    if (version < 2) {
      database.exec(`
        CREATE TABLE bridge_questions (
          agent_id TEXT NOT NULL,
          question_id INTEGER NOT NULL,
          question_text TEXT NOT NULL,
          header TEXT,
          guess TEXT,
          options_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          answer TEXT,
          telegram_chat_id INTEGER,
          telegram_message_id INTEGER,
          PRIMARY KEY (agent_id, question_id),
          UNIQUE (telegram_chat_id, telegram_message_id)
        ) STRICT;
        CREATE INDEX bridge_questions_relay_status
          ON bridge_questions (status, telegram_message_id, created_at);
        CREATE INDEX bridge_questions_agent_status
          ON bridge_questions (agent_id, status, updated_at);
      `)
    }

    database.exec(`PRAGMA user_version = ${BRIDGE_PROTOCOL_VERSION}`)
    database.exec("COMMIT")
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the original failure.
    }
    throw error
  }
}

const withDatabase = <T>(
  databasePath: string,
  use: (database: DatabaseSync) => T,
): T => {
  const directory = dirname(databasePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const database = new DatabaseSync(databasePath)
  chmodSync(databasePath, 0o600)
  try {
    initialize(database)
    return use(database)
  } finally {
    database.close()
  }
}

const transaction = <T>(database: DatabaseSync, mutate: () => T): T => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = mutate()
    database.exec("COMMIT")
    return result
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the original failure.
    }
    throw error
  }
}

const count = (
  database: DatabaseSync,
  table: "bridge_agents" | "bridge_messages",
): number =>
  numberField(
    rowFrom(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()),
    "count",
  )

const enabled = (database: DatabaseSync): boolean => {
  const row = optionalRowFrom(
    database
      .prepare("SELECT value FROM bridge_settings WHERE key = 'enabled'")
      .get(),
  )
  if (!row)
    throw bridgeError("corrupt_state", "bridge enabled setting is missing")
  const value = stringField(row, "value")
  if (value !== "0" && value !== "1")
    throw bridgeError("corrupt_state", "bridge enabled setting is malformed")
  return value === "1"
}

const expireMessages = (database: DatabaseSync, now: number): void => {
  database
    .prepare(
      `UPDATE bridge_messages
       SET status = 'failed', failure = 'expired', completed_at = ?, updated_at = ?, claim_token = NULL
       WHERE status IN ('queued', 'claimed') AND expires_at <= ?`,
    )
    .run(now, now, now)
}

const pruneTerminalMessages = (database: DatabaseSync, now: number): void => {
  database
    .prepare(
      "DELETE FROM bridge_messages WHERE status IN ('completed', 'failed') AND updated_at <= ?",
    )
    .run(Math.max(0, now - BRIDGE_MESSAGE_TTL_MS))
}

export const makeRemoteBridgeStore = (
  databasePath: string,
): RemoteBridgeStore => ({
  heartbeatAgent: (input) =>
    attempt("Could not heartbeat bridge agent", () =>
      withDatabase(databasePath, (database) => {
        const id = boundedIdentifier("agent id", input.id)
        const label = boundedBridgeText("agent label", input.label, 256)
        const cwd = boundedBridgeText("agent cwd", input.cwd, 1_024)
        const now = boundedTimestamp("now", input.now)
        const ttlMs = boundedTtl(input.ttlMs)
        const expiresAt = now + ttlMs
        if (!Number.isSafeInteger(expiresAt))
          throw bridgeError("invalid_input", "agent expiry exceeds time range")
        return transaction(database, () => {
          database
            .prepare("DELETE FROM bridge_agents WHERE expires_at <= ?")
            .run(now)
          if (count(database, "bridge_agents") >= MAX_AGENTS) {
            const exists = database
              .prepare("SELECT 1 FROM bridge_agents WHERE agent_id = ?")
              .get(id)
            if (!exists)
              throw bridgeError("capacity", "bridge agent capacity reached")
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
            .run(id, label, cwd, now, expiresAt, input.accepting ? 1 : 0)
          return agentFromRow(
            rowFrom(
              database
                .prepare("SELECT * FROM bridge_agents WHERE agent_id = ?")
                .get(id),
            ),
          )
        })
      }),
    ),
  listAgents: (now) =>
    attempt("Could not list bridge agents", () =>
      withDatabase(databasePath, (database) => {
        const at = boundedTimestamp("now", now)
        database
          .prepare("DELETE FROM bridge_agents WHERE expires_at <= ?")
          .run(at)
        return database
          .prepare(
            "SELECT * FROM bridge_agents WHERE expires_at > ? ORDER BY label, agent_id",
          )
          .all(at)
          .map((row) => agentFromRow(rowFrom(row)))
      }),
    ),
  enqueue: (input) =>
    attempt("Could not enqueue remote message", () =>
      withDatabase(databasePath, (database) => {
        const targetAgentId = boundedIdentifier(
          "target agent id",
          input.targetAgentId,
        )
        const requesterId = boundedIdentifier("requester id", input.requesterId)
        const dedupeKey = boundedIdentifier("dedupe key", input.dedupeKey, 256)
        const text = boundedBridgeText(
          "message",
          input.text,
          MAX_REMOTE_MESSAGE_CHARACTERS,
        )
        const now = boundedTimestamp("now", input.now)
        const ttlMs = boundedTtl(input.ttlMs)
        const expiresAt = now + ttlMs
        if (!Number.isSafeInteger(expiresAt))
          throw bridgeError(
            "invalid_input",
            "message expiry exceeds time range",
          )
        return transaction(database, () => {
          expireMessages(database, now)
          pruneTerminalMessages(database, now)
          if (!enabled(database))
            throw bridgeError("disabled", "remote message bridge is disabled")
          const agent = optionalRowFrom(
            database
              .prepare(
                "SELECT * FROM bridge_agents WHERE agent_id = ? AND expires_at > ?",
              )
              .get(targetAgentId, now),
          )
          if (!agent)
            throw bridgeError(
              "stale_agent",
              "target session is not bridge-ready",
            )
          const existing = optionalRowFrom(
            database
              .prepare(
                "SELECT * FROM bridge_messages WHERE requester_id = ? AND dedupe_key = ?",
              )
              .get(requesterId, dedupeKey),
          )
          if (existing) return messageFromRow(existing)
          if (count(database, "bridge_messages") >= MAX_MESSAGES) {
            throw bridgeError("capacity", "bridge message capacity reached")
          }
          const id = randomUUID()
          database
            .prepare(
              `INSERT INTO bridge_messages (
                 message_id, target_agent_id, requester_id, dedupe_key, text,
                 created_at, expires_at, updated_at, status
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
            )
            .run(
              id,
              targetAgentId,
              requesterId,
              dedupeKey,
              text,
              now,
              expiresAt,
              now,
            )
          return messageFromRow(
            rowFrom(
              database
                .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                .get(id),
            ),
          )
        })
      }),
    ),
  claimNext: (input) =>
    attempt("Could not claim remote message", () =>
      withDatabase(databasePath, (database) => {
        const agentId = boundedIdentifier("agent id", input.agentId)
        const now = boundedTimestamp("now", input.now)
        return transaction(database, () => {
          expireMessages(database, now)
          if (!enabled(database)) return undefined
          const row = optionalRowFrom(
            database
              .prepare(
                `SELECT * FROM bridge_messages
                 WHERE target_agent_id = ? AND status = 'queued' AND expires_at > ?
                 ORDER BY created_at, message_id LIMIT 1`,
              )
              .get(agentId, now),
          )
          if (!row) return undefined
          const id = stringField(row, "message_id") ?? ""
          const claimToken = randomUUID()
          database
            .prepare(
              `UPDATE bridge_messages
               SET status = 'claimed', claim_token = ?, claimed_at = ?, updated_at = ?
               WHERE message_id = ? AND status = 'queued'`,
            )
            .run(claimToken, now, now, id)
          return messageFromRow(
            rowFrom(
              database
                .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                .get(id),
            ),
          )
        })
      }),
    ),
  complete: (input) =>
    attempt("Could not complete remote message", () =>
      withDatabase(databasePath, (database) => {
        const messageId = boundedIdentifier("message id", input.messageId)
        const claimToken = boundedIdentifier("claim token", input.claimToken)
        const response = boundedBridgeText(
          "response",
          input.response,
          MAX_REMOTE_RESPONSE_CHARACTERS,
        )
        const now = boundedTimestamp("now", input.now)
        return transaction(database, () => {
          const result = database
            .prepare(
              `UPDATE bridge_messages
               SET status = 'completed', response = ?, completed_at = ?, updated_at = ?, claim_token = NULL
               WHERE message_id = ? AND status = 'claimed' AND claim_token = ? AND expires_at > ?`,
            )
            .run(response, now, now, messageId, claimToken, now)
          if (result.changes !== 1)
            throw bridgeError(
              "invalid_transition",
              "stale remote message claim",
            )
          return messageFromRow(
            rowFrom(
              database
                .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                .get(messageId),
            ),
          )
        })
      }),
    ),
  fail: (input) =>
    attempt("Could not fail remote message", () =>
      withDatabase(databasePath, (database) => {
        const messageId = boundedIdentifier("message id", input.messageId)
        const claimToken = boundedIdentifier("claim token", input.claimToken)
        const now = boundedTimestamp("now", input.now)
        return transaction(database, () => {
          const result = database
            .prepare(
              `UPDATE bridge_messages
               SET status = 'failed', failure = ?, completed_at = ?, updated_at = ?, claim_token = NULL
               WHERE message_id = ? AND status = 'claimed' AND claim_token = ?`,
            )
            .run(input.failure, now, now, messageId, claimToken)
          if (result.changes !== 1)
            throw bridgeError(
              "invalid_transition",
              "stale remote message claim",
            )
          return messageFromRow(
            rowFrom(
              database
                .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                .get(messageId),
            ),
          )
        })
      }),
    ),
  get: (messageId, now) =>
    attempt("Could not read remote message", () =>
      withDatabase(databasePath, (database) => {
        const id = boundedIdentifier("message id", messageId)
        const at = boundedTimestamp("now", now)
        expireMessages(database, at)
        const row = optionalRowFrom(
          database
            .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
            .get(id),
        )
        if (!row) throw bridgeError("not_found", "remote message not found")
        return messageFromRow(row)
      }),
    ),
  setEnabled: (value) =>
    attempt("Could not update bridge state", () =>
      withDatabase(databasePath, (database) => {
        database
          .prepare("UPDATE bridge_settings SET value = ? WHERE key = 'enabled'")
          .run(value ? "1" : "0")
        return value
      }),
    ),
  isEnabled: () =>
    attempt("Could not read bridge state", () =>
      withDatabase(databasePath, enabled),
    ),
  syncQuestions: (input) =>
    attempt("Could not sync bridge questions", () =>
      withDatabase(databasePath, (database) => {
        const agentId = boundedIdentifier("agent id", input.agentId)
        const now = boundedTimestamp("now", input.now)
        const questions = input.questions.map(boundedQuestionSnapshot)
        const questionIds = new Set(questions.map(({ id }) => id))

        transaction(database, () => {
          for (const question of questions) {
            const existing = optionalRowFrom(
              database
                .prepare(
                  "SELECT status FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
                )
                .get(agentId, question.id),
            )
            const existingStatus = existing
              ? stringField(existing, "status")
              : undefined
            const optionsJson = question.options
              ? JSON.stringify(question.options)
              : null

            if (question.status === "pending") {
              if (
                existingStatus === "answered" ||
                existingStatus === "delivered"
              )
                continue

              if (existingStatus === undefined) {
                database
                  .prepare(
                    `INSERT INTO bridge_questions (
                       agent_id, question_id, question_text, header, guess, options_json,
                       created_at, updated_at, status
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                  )
                  .run(
                    agentId,
                    question.id,
                    question.question,
                    question.header ?? null,
                    question.guess ?? null,
                    optionsJson,
                    now,
                    now,
                  )
                continue
              }

              const reopened = existingStatus === "resolved"
              database
                .prepare(
                  `UPDATE bridge_questions
                   SET question_text = ?, header = ?, guess = ?, options_json = ?,
                       updated_at = ?, status = 'pending', answer = NULL,
                       telegram_chat_id = CASE WHEN ? THEN NULL ELSE telegram_chat_id END,
                       telegram_message_id = CASE WHEN ? THEN NULL ELSE telegram_message_id END
                   WHERE agent_id = ? AND question_id = ?`,
                )
                .run(
                  question.question,
                  question.header ?? null,
                  question.guess ?? null,
                  optionsJson,
                  now,
                  reopened ? 1 : 0,
                  reopened ? 1 : 0,
                  agentId,
                  question.id,
                )
              continue
            }

            database
              .prepare(
                `INSERT INTO bridge_questions (
                   agent_id, question_id, question_text, header, guess, options_json,
                   created_at, updated_at, status
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'resolved')
                 ON CONFLICT(agent_id, question_id) DO UPDATE SET
                   question_text = excluded.question_text,
                   header = excluded.header,
                   guess = excluded.guess,
                   options_json = excluded.options_json,
                   updated_at = excluded.updated_at,
                   status = 'resolved',
                   answer = NULL`,
              )
              .run(
                agentId,
                question.id,
                question.question,
                question.header ?? null,
                question.guess ?? null,
                optionsJson,
                now,
                now,
              )
          }

          const existing = database
            .prepare(
              "SELECT question_id, status FROM bridge_questions WHERE agent_id = ?",
            )
            .all(agentId)
            .map(rowFrom)
          for (const row of existing) {
            const questionId = numberField(row, "question_id")
            if (
              questionIds.has(questionId) ||
              stringField(row, "status") === "answered"
            )
              continue
            database
              .prepare(
                "DELETE FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
              )
              .run(agentId, questionId)
          }
        })
      }),
    ),
  listUnrelayedQuestions: (now) =>
    attempt("Could not list unrelayed bridge questions", () =>
      withDatabase(databasePath, (database) => {
        const at = boundedTimestamp("now", now)
        return database
          .prepare(
            `SELECT question.*
             FROM bridge_questions AS question
             INNER JOIN bridge_agents AS agent ON agent.agent_id = question.agent_id
             WHERE question.status = 'pending'
               AND question.telegram_message_id IS NULL
               AND agent.expires_at > ?
             ORDER BY question.created_at, question.agent_id, question.question_id
             LIMIT 100`,
          )
          .all(at)
          .map((row) => questionFromRow(rowFrom(row)))
      }),
    ),
  linkTelegramQuestion: (input) =>
    attempt("Could not link Telegram question", () =>
      withDatabase(databasePath, (database) => {
        const agentId = boundedIdentifier("agent id", input.agentId)
        const questionId = positiveSafeInteger("question id", input.questionId)
        const chatId = positiveSafeInteger("Telegram chat id", input.chatId)
        const messageId = positiveSafeInteger(
          "Telegram message id",
          input.messageId,
        )
        const now = boundedTimestamp("now", input.now)

        return transaction(database, () => {
          const result = database
            .prepare(
              `UPDATE bridge_questions
               SET telegram_chat_id = ?, telegram_message_id = ?, updated_at = ?
               WHERE agent_id = ? AND question_id = ?
                 AND status = 'pending' AND telegram_message_id IS NULL`,
            )
            .run(chatId, messageId, now, agentId, questionId)
          if (result.changes !== 1) {
            throw bridgeError(
              "invalid_transition",
              "question is already relayed or terminal",
            )
          }

          return questionFromRow(
            rowFrom(
              database
                .prepare(
                  "SELECT * FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
                )
                .get(agentId, questionId),
            ),
          )
        })
      }),
    ),
  answerTelegramQuestion: (input) =>
    attempt("Could not answer Telegram question", () =>
      withDatabase(databasePath, (database) => {
        const chatId = positiveSafeInteger("Telegram chat id", input.chatId)
        const messageId = positiveSafeInteger(
          "Telegram message id",
          input.messageId,
        )
        const rawAnswer = boundedBridgeText(
          "question answer",
          input.answer,
          MAX_REMOTE_ANSWER_CHARACTERS,
        )
        const now = boundedTimestamp("now", input.now)

        return transaction(database, () => {
          const row = optionalRowFrom(
            database
              .prepare(
                `SELECT * FROM bridge_questions
                 WHERE telegram_chat_id = ? AND telegram_message_id = ?`,
              )
              .get(chatId, messageId),
          )
          if (!row)
            throw bridgeError(
              "not_found",
              "Telegram question binding not found",
            )
          if (stringField(row, "status") !== "pending") {
            throw bridgeError(
              "invalid_transition",
              "Telegram question is already terminal",
            )
          }

          const options = questionOptionsFromJson(
            stringField(row, "options_json", true),
          )
          const optionIndex = /^[1-4]$/.test(rawAnswer)
            ? Number(rawAnswer) - 1
            : -1
          const answer = options?.[optionIndex]?.label ?? rawAnswer
          const result = database
            .prepare(
              `UPDATE bridge_questions
               SET status = 'answered', answer = ?, updated_at = ?
               WHERE agent_id = ? AND question_id = ? AND status = 'pending'`,
            )
            .run(
              answer,
              now,
              stringField(row, "agent_id"),
              numberField(row, "question_id"),
            )
          if (result.changes !== 1) {
            throw bridgeError(
              "invalid_transition",
              "Telegram question answer raced",
            )
          }

          return {
            agentId: stringField(row, "agent_id") ?? "",
            questionId: numberField(row, "question_id"),
            answer,
          }
        })
      }),
    ),
  takeQuestionResolution: (input) =>
    attempt("Could not take bridge question resolution", () =>
      withDatabase(databasePath, (database) => {
        const agentId = boundedIdentifier("agent id", input.agentId)
        const now = boundedTimestamp("now", input.now)

        return transaction(database, () => {
          const row = optionalRowFrom(
            database
              .prepare(
                `SELECT * FROM bridge_questions
                 WHERE agent_id = ? AND status = 'answered'
                 ORDER BY updated_at, question_id
                 LIMIT 1`,
              )
              .get(agentId),
          )
          if (!row) return undefined

          const questionId = numberField(row, "question_id")
          const result = database
            .prepare(
              `UPDATE bridge_questions
               SET status = 'delivered', updated_at = ?
               WHERE agent_id = ? AND question_id = ? AND status = 'answered'`,
            )
            .run(now, agentId, questionId)
          if (result.changes !== 1) {
            throw bridgeError(
              "invalid_transition",
              "question resolution delivery raced",
            )
          }

          return resolutionFromRow(row)
        })
      }),
    ),
})
