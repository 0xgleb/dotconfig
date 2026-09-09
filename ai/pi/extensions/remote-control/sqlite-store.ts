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
  boundedBridgeImagesEffect,
  boundedBridgeTextEffect,
  boundedIdentifierEffect,
  boundedTimestampEffect,
  boundedTtlEffect,
  isBridgeWorkDelivery,
  workDeliveryAcceptsInbox,
  type BridgeAgent,
  type BridgeWorkDelivery,
  type BridgeQuestion,
  type RemoteFailure,
  type RemoteImage,
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
  readonly workDelivery: BridgeWorkDelivery
  readonly now: number
  readonly ttlMs: number
}

export interface EnqueueRemoteMessageInput {
  readonly targetAgentId: string
  readonly requesterId: string
  readonly dedupeKey: string
  readonly text: string
  readonly images?: readonly RemoteImage[]
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

export interface QuestionRelayStatusInput {
  readonly agentId: string
  readonly questionId: number
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

export interface AnswerPendingTelegramQuestionInput {
  readonly chatId: number
  readonly answer: string
  readonly now: number
}

export interface DismissQuestionInput {
  readonly agentId: string
  readonly questionId: number
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
  readonly listPendingQuestions: (
    now: number,
  ) => Effect.Effect<readonly BridgeQuestion[], RemoteBridgeError>
  readonly listUnrelayedQuestions: (
    now: number,
  ) => Effect.Effect<readonly BridgeQuestion[], RemoteBridgeError>
  readonly isQuestionRelayed: (
    input: QuestionRelayStatusInput,
  ) => Effect.Effect<boolean, RemoteBridgeError>
  readonly isQuestionHistoricallyRelayed: (
    input: QuestionRelayStatusInput,
  ) => Effect.Effect<boolean, RemoteBridgeError>
  readonly markQuestionDeliveredInConversation: (
    input: DismissQuestionInput,
  ) => Effect.Effect<void, RemoteBridgeError>
  readonly linkTelegramQuestion: (
    input: LinkTelegramQuestionInput,
  ) => Effect.Effect<BridgeQuestion, RemoteBridgeError>
  readonly answerTelegramQuestion: (
    input: AnswerTelegramQuestionInput,
  ) => Effect.Effect<RemoteQuestionResolution, RemoteBridgeError>
  readonly answerSolePendingTelegramQuestion: (
    input: AnswerPendingTelegramQuestionInput,
  ) => Effect.Effect<RemoteQuestionResolution | undefined, RemoteBridgeError>
  readonly dismissQuestion: (
    input: DismissQuestionInput,
  ) => Effect.Effect<BridgeQuestion, RemoteBridgeError>
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
    catch: error => asBridgeError(error, fallback),
  })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const rowFromEffect = (
  value: unknown,
): Effect.Effect<Row, RemoteBridgeError> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Effect.succeed(value)
    : Effect.fail(
        bridgeError("corrupt_state", "bridge query returned a malformed row"),
      )

const optionalRowFromEffect = (
  value: unknown,
): Effect.Effect<Row | undefined, RemoteBridgeError> =>
  value === undefined ? Effect.succeed(undefined) : rowFromEffect(value)

const requiredStringFieldEffect = (
  row: Row,
  key: string,
): Effect.Effect<string, RemoteBridgeError> =>
  typeof row[key] === "string"
    ? Effect.succeed(row[key])
    : Effect.fail(
        bridgeError("corrupt_state", `bridge column ${key} is malformed`),
      )

const optionalStringFieldEffect = (
  row: Row,
  key: string,
): Effect.Effect<string | undefined, RemoteBridgeError> =>
  row[key] === null
    ? Effect.succeed(undefined)
    : requiredStringFieldEffect(row, key)

const numberFieldEffect = (
  row: Row,
  key: string,
): Effect.Effect<number, RemoteBridgeError> => {
  const value = row[key]
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Effect.succeed(value)
    : Effect.fail(
        bridgeError("corrupt_state", `bridge column ${key} is malformed`),
      )
}

const booleanFieldEffect = (
  row: Row,
  key: string,
): Effect.Effect<boolean, RemoteBridgeError> =>
  Effect.flatMap(numberFieldEffect(row, key), value =>
    value === 0 || value === 1
      ? Effect.succeed(value === 1)
      : Effect.fail(
          bridgeError("corrupt_state", `bridge column ${key} is malformed`),
        ),
  )

const workDeliveryFieldEffect = (
  row: Row,
): Effect.Effect<BridgeWorkDelivery, RemoteBridgeError> =>
  Effect.flatMap(requiredStringFieldEffect(row, "work_delivery"), value =>
    isBridgeWorkDelivery(value)
      ? Effect.succeed(value)
      : Effect.fail(
          bridgeError(
            "corrupt_state",
            "bridge agent work delivery is malformed",
          ),
        ),
  )

const agentFromRowEffect = (
  row: Row,
): Effect.Effect<BridgeAgent, RemoteBridgeError> =>
  Effect.gen(function* () {
    return {
      id: yield* requiredStringFieldEffect(row, "agent_id"),
      label: yield* requiredStringFieldEffect(row, "label"),
      cwd: yield* requiredStringFieldEffect(row, "cwd"),
      heartbeatAt: yield* numberFieldEffect(row, "heartbeat_at"),
      expiresAt: yield* numberFieldEffect(row, "expires_at"),
      accepting: yield* booleanFieldEffect(row, "accepting"),
      workDelivery: yield* workDeliveryFieldEffect(row),
      queuedMessages:
        row.queued_messages === undefined
          ? 0
          : yield* numberFieldEffect(row, "queued_messages"),
    }
  })

const imagesFromRowEffect = (
  row: Row,
): Effect.Effect<readonly RemoteImage[], RemoteBridgeError> =>
  Effect.gen(function* () {
    const encoded = yield* requiredStringFieldEffect(row, "images_json")
    const decoded = yield* Effect.try({
      try: (): unknown => JSON.parse(encoded),
      catch: () => bridgeError("corrupt_state", "bridge images are malformed"),
    })
    if (!Array.isArray(decoded))
      return yield* Effect.fail(
        bridgeError("corrupt_state", "bridge images are malformed"),
      )
    return yield* boundedBridgeImagesEffect(decoded as RemoteImage[]).pipe(
      Effect.mapError(() =>
        bridgeError("corrupt_state", "bridge images are malformed"),
      ),
    )
  })

const messageFromRowEffect = (
  row: Row,
): Effect.Effect<RemoteMessage, RemoteBridgeError> =>
  Effect.gen(function* () {
    const status = yield* requiredStringFieldEffect(row, "status")
    const base = {
      id: yield* requiredStringFieldEffect(row, "message_id"),
      targetAgentId: yield* requiredStringFieldEffect(row, "target_agent_id"),
      requesterId: yield* requiredStringFieldEffect(row, "requester_id"),
      dedupeKey: yield* requiredStringFieldEffect(row, "dedupe_key"),
      text: yield* requiredStringFieldEffect(row, "text"),
      images: yield* imagesFromRowEffect(row),
      createdAt: yield* numberFieldEffect(row, "created_at"),
      expiresAt: yield* numberFieldEffect(row, "expires_at"),
      updatedAt: yield* numberFieldEffect(row, "updated_at"),
    }
    if (status === "queued") return { ...base, status }
    if (status === "claimed")
      return {
        ...base,
        status,
        claimToken: yield* requiredStringFieldEffect(row, "claim_token"),
        claimedAt: yield* numberFieldEffect(row, "claimed_at"),
      }
    if (status === "completed")
      return {
        ...base,
        status,
        response: yield* requiredStringFieldEffect(row, "response"),
        completedAt: yield* numberFieldEffect(row, "completed_at"),
      }
    if (status === "failed") {
      const failure = yield* requiredStringFieldEffect(row, "failure")
      if (
        failure !== "aborted" &&
        failure !== "bridge_disabled" &&
        failure !== "expired" &&
        failure !== "model_error" &&
        failure !== "session_ended"
      )
        return yield* Effect.fail(
          bridgeError("corrupt_state", "bridge failure is malformed"),
        )
      const claimedAt =
        row.claimed_at === null
          ? undefined
          : yield* numberFieldEffect(row, "claimed_at")
      return {
        ...base,
        status,
        failure,
        ...(claimedAt === undefined ? {} : { claimedAt }),
        completedAt: yield* numberFieldEffect(row, "completed_at"),
      }
    }
    return yield* Effect.fail(
      bridgeError("corrupt_state", "bridge message status is malformed"),
    )
  })

const positiveSafeIntegerEffect = (
  label: string,
  value: number,
): Effect.Effect<number, RemoteBridgeError> =>
  Number.isSafeInteger(value) && value >= 1
    ? Effect.succeed(value)
    : Effect.fail(
        bridgeError(
          "invalid_input",
          `${label} must be a positive safe integer`,
        ),
      )

const questionOptionsFromJsonEffect = (
  value: string | undefined,
): Effect.Effect<
  readonly RemoteQuestionOption[] | undefined,
  RemoteBridgeError
> =>
  Effect.gen(function* () {
    if (value === undefined) return undefined
    const decoded = yield* Effect.try({
      try: (): unknown => JSON.parse(value),
      catch: () =>
        bridgeError("corrupt_state", "bridge question options are malformed"),
    })
    if (
      !Array.isArray(decoded) ||
      decoded.length < 2 ||
      decoded.length > 4 ||
      !decoded.every(
        option =>
          isRecord(option) &&
          typeof option.label === "string" &&
          option.label.length > 0 &&
          option.label.length <= 80 &&
          (option.description === undefined ||
            (typeof option.description === "string" &&
              option.description.length <= 160)),
      )
    )
      return yield* Effect.fail(
        bridgeError("corrupt_state", "bridge question options are malformed"),
      )
    return decoded as unknown as readonly RemoteQuestionOption[]
  })

const questionFromRowEffect = (
  row: Row,
): Effect.Effect<BridgeQuestion, RemoteBridgeError> =>
  Effect.gen(function* () {
    const header = yield* optionalStringFieldEffect(row, "header")
    const guess = yield* optionalStringFieldEffect(row, "guess")
    const options = yield* questionOptionsFromJsonEffect(
      yield* optionalStringFieldEffect(row, "options_json"),
    )
    return {
      agentId: yield* requiredStringFieldEffect(row, "agent_id"),
      questionId: yield* numberFieldEffect(row, "question_id"),
      question: yield* requiredStringFieldEffect(row, "question_text"),
      ...(header ? { header } : {}),
      ...(guess ? { guess } : {}),
      ...(options ? { options } : {}),
      createdAt: yield* numberFieldEffect(row, "created_at"),
      updatedAt: yield* numberFieldEffect(row, "updated_at"),
    }
  })

const resolutionFromRowEffect = (
  row: Row,
): Effect.Effect<RemoteQuestionResolution, RemoteBridgeError> =>
  Effect.gen(function* () {
    return {
      agentId: yield* requiredStringFieldEffect(row, "agent_id"),
      questionId: yield* numberFieldEffect(row, "question_id"),
      answer: yield* requiredStringFieldEffect(row, "answer"),
    }
  })

const boundedOptionalTextEffect = (
  label: string,
  value: string | undefined,
  maximum: number,
): Effect.Effect<string | undefined, RemoteBridgeError> =>
  value === undefined
    ? Effect.succeed(undefined)
    : boundedBridgeTextEffect(label, value, maximum)

const boundedQuestionSnapshotEffect = (
  question: RemoteQuestionSnapshot,
): Effect.Effect<RemoteQuestionSnapshot, RemoteBridgeError> =>
  Effect.gen(function* () {
    const options = question.options
      ? yield* Effect.forEach(question.options, option =>
          Effect.gen(function* () {
            const label = yield* boundedBridgeTextEffect(
              "question option label",
              option.label,
              80,
            )
            const description = yield* boundedOptionalTextEffect(
              "question option description",
              option.description,
              160,
            )
            return {
              label,
              ...(description === undefined ? {} : { description }),
            }
          }),
        )
      : undefined
    if (options !== undefined && (options.length < 2 || options.length > 4))
      return yield* Effect.fail(
        bridgeError(
          "invalid_input",
          "question options must contain 2-4 choices",
        ),
      )
    const header = yield* boundedOptionalTextEffect(
      "question header",
      question.header,
      16,
    )
    const guess = yield* boundedOptionalTextEffect(
      "question guess",
      question.guess,
      2_000,
    )
    return {
      id: yield* positiveSafeIntegerEffect("question id", question.id),
      status: question.status,
      question: yield* boundedBridgeTextEffect(
        "question",
        question.question,
        MAX_REMOTE_QUESTION_CHARACTERS,
      ),
      ...(header === undefined ? {} : { header }),
      ...(guess === undefined ? {} : { guess }),
      ...(options ? { options } : {}),
    }
  })

const purgeOrphanedConversationDeliveries = (database: DatabaseSync): void => {
  const hasQuestionTable =
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("bridge_questions") !== undefined
  if (!hasQuestionTable) return
  database
    .prepare(
      `DELETE FROM bridge_question_delivery_channels
       WHERE NOT EXISTS (
         SELECT 1
         FROM bridge_questions AS question
         WHERE question.agent_id = bridge_question_delivery_channels.agent_id
           AND question.question_id = bridge_question_delivery_channels.question_id
       )`,
    )
    .run()
}

const initializeEffect = (
  database: DatabaseSync,
): Effect.Effect<void, RemoteBridgeError> =>
  Effect.gen(function* () {
    yield* attempt("Could not configure remote bridge database", () => {
      database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
      database.prepare("PRAGMA journal_mode = WAL").get()
      database.exec("PRAGMA synchronous = NORMAL;")
    })
    const versionRow = yield* attempt(
      "Could not read bridge schema version",
      () => database.prepare("PRAGMA user_version").get(),
    ).pipe(Effect.flatMap(rowFromEffect))
    const version = yield* numberFieldEffect(versionRow, "user_version")
    if (version < 0 || version > BRIDGE_PROTOCOL_VERSION)
      return yield* Effect.fail(
        bridgeError(
          "corrupt_state",
          `unsupported bridge protocol version ${version}`,
        ),
      )
    const needsWorkDeliveryColumn =
      (yield* attempt("Could not inspect bridge agent schema", () =>
        database
          .prepare(
            "SELECT 1 AS present FROM pragma_table_info('bridge_agents') WHERE name = ?",
          )
          .get("work_delivery"),
      )) === undefined
    const needsQuestionDeliveryChannelsTable =
      (yield* attempt("Could not inspect question delivery schema", () =>
        database
          .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get("bridge_question_delivery_channels"),
      )) === undefined
    if (!needsQuestionDeliveryChannelsTable) {
      const columnValues = yield* attempt(
        "Could not inspect question delivery columns",
        () =>
          database
            .prepare("PRAGMA table_info(bridge_question_delivery_channels)")
            .all(),
      )
      const columns = yield* Effect.forEach(columnValues, rowFromEffect)
      const expectedColumns = [
        { name: "agent_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "question_id", type: "INTEGER", notnull: 1, pk: 2 },
        { name: "channel", type: "TEXT", notnull: 1, pk: 0 },
        { name: "delivered_at", type: "INTEGER", notnull: 1, pk: 0 },
      ] as const
      let schemaMatches = columns.length === expectedColumns.length
      for (const [index, expected] of expectedColumns.entries()) {
        const column = columns[index]
        if (!column) {
          schemaMatches = false
          continue
        }
        const name = yield* requiredStringFieldEffect(column, "name")
        const type = yield* requiredStringFieldEffect(column, "type")
        const notnull = yield* numberFieldEffect(column, "notnull")
        const pk = yield* numberFieldEffect(column, "pk")
        schemaMatches &&=
          name === expected.name &&
          type === expected.type &&
          notnull === expected.notnull &&
          pk === expected.pk
      }
      const table = yield* attempt(
        "Could not inspect question delivery table",
        () =>
          database
            .prepare(
              "SELECT strict FROM pragma_table_list WHERE name = ? AND type = 'table'",
            )
            .get("bridge_question_delivery_channels"),
      ).pipe(Effect.flatMap(optionalRowFromEffect))
      const definition = yield* attempt(
        "Could not inspect question delivery definition",
        () =>
          database
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get("bridge_question_delivery_channels"),
      ).pipe(Effect.flatMap(optionalRowFromEffect))
      const definitionSql = definition
        ? yield* requiredStringFieldEffect(definition, "sql")
        : ""
      const hasChannelConstraint =
        /CHECK\s*\(\s*channel\s+IN\s*\(\s*'conversation'\s*\)\s*\)/i.test(
          definitionSql,
        )
      const strict = table
        ? yield* numberFieldEffect(table, "strict")
        : undefined
      if (!schemaMatches || strict !== 1 || !hasChannelConstraint)
        return yield* Effect.fail(
          bridgeError(
            "corrupt_state",
            "bridge conversation-delivery schema is malformed",
          ),
        )
    }
    if (
      version === BRIDGE_PROTOCOL_VERSION &&
      !needsWorkDeliveryColumn &&
      !needsQuestionDeliveryChannelsTable
    ) {
      yield* attempt("Could not purge orphaned question deliveries", () =>
        purgeOrphanedConversationDeliveries(database),
      )
      return
    }
    yield* transactionEffect(
      database,
      attempt("Could not migrate remote bridge database", () => {
        if (version === 0)
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
        if (version < 2)
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
        if (version < 3)
          database.exec(
            "ALTER TABLE bridge_messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'",
          )
        if (version < 4)
          database.exec(`
            CREATE TABLE bridge_question_relays (
              agent_id TEXT NOT NULL,
              question_id INTEGER NOT NULL,
              telegram_message_id INTEGER NOT NULL,
              relayed_at INTEGER NOT NULL,
              PRIMARY KEY (agent_id, question_id)
            ) STRICT;
            INSERT INTO bridge_question_relays (
              agent_id, question_id, telegram_message_id, relayed_at
            )
            SELECT agent_id, question_id, telegram_message_id, updated_at
            FROM bridge_questions
            WHERE telegram_message_id IS NOT NULL;
          `)
        if (needsWorkDeliveryColumn)
          database.exec(
            "ALTER TABLE bridge_agents ADD COLUMN work_delivery TEXT NOT NULL DEFAULT 'monitor-only' CHECK (work_delivery IN ('native-pi', 'cli-poll', 'inline-only', 'monitor-only'))",
          )
        if (needsQuestionDeliveryChannelsTable)
          database.exec(`
            CREATE TABLE bridge_question_delivery_channels (
              agent_id TEXT NOT NULL,
              question_id INTEGER NOT NULL,
              channel TEXT NOT NULL CHECK (channel IN ('conversation')),
              delivered_at INTEGER NOT NULL,
              PRIMARY KEY (agent_id, question_id)
            ) STRICT;
          `)
        purgeOrphanedConversationDeliveries(database)
        database.exec(`PRAGMA user_version = ${BRIDGE_PROTOCOL_VERSION}`)
      }),
    )
  })

const withDatabaseEffect = <T>(
  databasePath: string,
  use: (database: DatabaseSync) => Effect.Effect<T, RemoteBridgeError>,
): Effect.Effect<T, RemoteBridgeError> =>
  Effect.acquireUseRelease(
    attempt("Could not open remote bridge database", () => {
      const directory = dirname(databasePath)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      const database = new DatabaseSync(databasePath)
      chmodSync(databasePath, 0o600)
      return database
    }),
    database =>
      initializeEffect(database).pipe(Effect.flatMap(() => use(database))),
    database =>
      attempt("Could not close remote bridge database", () =>
        database.close(),
      ).pipe(Effect.ignore),
  )

const transactionEffect = <T>(
  database: DatabaseSync,
  mutate: Effect.Effect<T, RemoteBridgeError>,
): Effect.Effect<T, RemoteBridgeError> =>
  Effect.gen(function* () {
    yield* attempt("Could not begin remote bridge transaction", () =>
      database.exec("BEGIN IMMEDIATE"),
    )
    const outcome = yield* Effect.either(
      Effect.gen(function* () {
        const result = yield* mutate
        yield* attempt("Could not commit remote bridge transaction", () =>
          database.exec("COMMIT"),
        )
        return result
      }),
    )
    if (outcome._tag === "Right") return outcome.right
    yield* attempt("Could not roll back remote bridge transaction", () =>
      database.exec("ROLLBACK"),
    ).pipe(Effect.ignore)
    return yield* Effect.fail(outcome.left)
  })

const countEffect = (
  database: DatabaseSync,
  table: "bridge_agents" | "bridge_messages",
): Effect.Effect<number, RemoteBridgeError> =>
  attempt("Could not count remote bridge rows", () =>
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
  ).pipe(
    Effect.flatMap(rowFromEffect),
    Effect.flatMap(row => numberFieldEffect(row, "count")),
  )

const count = (
  database: DatabaseSync,
  table: "bridge_agents" | "bridge_messages",
): number =>
  numberField(
    rowFrom(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()),
    "count",
  )

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

const enabledEffect = (
  database: DatabaseSync,
): Effect.Effect<boolean, RemoteBridgeError> =>
  attempt("Could not read remote bridge state", () =>
    database
      .prepare("SELECT value FROM bridge_settings WHERE key = 'enabled'")
      .get(),
  ).pipe(
    Effect.flatMap(optionalRowFromEffect),
    Effect.flatMap(row =>
      row
        ? requiredStringFieldEffect(row, "value")
        : Effect.fail(
            bridgeError("corrupt_state", "bridge enabled setting is missing"),
          ),
    ),
    Effect.flatMap(value =>
      value === "0" || value === "1"
        ? Effect.succeed(value === "1")
        : Effect.fail(
            bridgeError("corrupt_state", "bridge enabled setting is malformed"),
          ),
    ),
  )

const expireMessagesEffect = (
  database: DatabaseSync,
  now: number,
): Effect.Effect<void, RemoteBridgeError> =>
  attempt("Could not expire remote messages", () => {
    database
      .prepare(
        `UPDATE bridge_messages
         SET status = 'failed', failure = 'expired', completed_at = ?, updated_at = ?, claim_token = NULL
         WHERE status IN ('queued', 'claimed') AND expires_at <= ?`,
      )
      .run(now, now, now)
  })

const pruneTerminalMessagesEffect = (
  database: DatabaseSync,
  now: number,
): Effect.Effect<void, RemoteBridgeError> =>
  attempt("Could not prune terminal remote messages", () => {
    database
      .prepare(
        "DELETE FROM bridge_messages WHERE status IN ('completed', 'failed') AND updated_at <= ?",
      )
      .run(Math.max(0, now - BRIDGE_MESSAGE_TTL_MS))
  })

export const makeRemoteBridgeStore = (
  databasePath: string,
): RemoteBridgeStore => ({
  heartbeatAgent: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const id = yield* boundedIdentifierEffect("agent id", input.id)
        const label = yield* boundedBridgeTextEffect(
          "agent label",
          input.label,
          256,
        )
        const cwd = yield* boundedBridgeTextEffect(
          "agent cwd",
          input.cwd,
          1_024,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        if (!isBridgeWorkDelivery(input.workDelivery))
          return yield* Effect.fail(
            bridgeError(
              "invalid_input",
              "agent work delivery is not supported",
            ),
          )
        const ttlMs = yield* boundedTtlEffect(input.ttlMs)
        const expiresAt = now + ttlMs
        if (!Number.isSafeInteger(expiresAt))
          return yield* Effect.fail(
            bridgeError("invalid_input", "agent expiry exceeds time range"),
          )
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            yield* attempt("Could not expire bridge agents", () =>
              database
                .prepare("DELETE FROM bridge_agents WHERE expires_at <= ?")
                .run(now),
            )
            if ((yield* countEffect(database, "bridge_agents")) >= MAX_AGENTS) {
              const existing = yield* attempt(
                "Could not inspect bridge agent capacity",
                () =>
                  database
                    .prepare("SELECT 1 FROM bridge_agents WHERE agent_id = ?")
                    .get(id),
              )
              if (!existing)
                return yield* Effect.fail(
                  bridgeError("capacity", "bridge agent capacity reached"),
                )
            }
            yield* attempt("Could not persist bridge agent heartbeat", () =>
              database
                .prepare(
                  `INSERT INTO bridge_agents (
                     agent_id, label, cwd, heartbeat_at, expires_at, accepting, work_delivery
                   ) VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(agent_id) DO UPDATE SET
                     label = excluded.label,
                     cwd = excluded.cwd,
                     heartbeat_at = excluded.heartbeat_at,
                     expires_at = excluded.expires_at,
                     accepting = excluded.accepting,
                     work_delivery = excluded.work_delivery`,
                )
                .run(
                  id,
                  label,
                  cwd,
                  now,
                  expiresAt,
                  input.accepting ? 1 : 0,
                  input.workDelivery,
                ),
            )
            const row = yield* attempt("Could not read bridge agent", () =>
              database
                .prepare(
                  `SELECT a.*,
                     (SELECT COUNT(*) FROM bridge_messages AS m
                      WHERE m.target_agent_id = a.agent_id AND m.status = 'queued')
                       AS queued_messages
                   FROM bridge_agents AS a WHERE a.agent_id = ?`,
                )
                .get(id),
            ).pipe(Effect.flatMap(rowFromEffect))
            return yield* agentFromRowEffect(row)
          }),
        )
      }),
    ),
  listAgents: now =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const at = yield* boundedTimestampEffect("now", now)
        yield* attempt("Could not expire bridge agents", () =>
          database
            .prepare("DELETE FROM bridge_agents WHERE expires_at <= ?")
            .run(at),
        )
        const rows = yield* attempt("Could not list bridge agents", () =>
          database
            .prepare(
              `SELECT a.*,
                 (SELECT COUNT(*) FROM bridge_messages AS m
                  WHERE m.target_agent_id = a.agent_id AND m.status = 'queued')
                   AS queued_messages
               FROM bridge_agents AS a
               WHERE a.expires_at > ? ORDER BY a.label, a.agent_id`,
            )
            .all(at),
        )
        return yield* Effect.forEach(rows, row =>
          rowFromEffect(row).pipe(Effect.flatMap(agentFromRowEffect)),
        )
      }),
    ),
  enqueue: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const targetAgentId = yield* boundedIdentifierEffect(
          "target agent id",
          input.targetAgentId,
        )
        const requesterId = yield* boundedIdentifierEffect(
          "requester id",
          input.requesterId,
        )
        const dedupeKey = yield* boundedIdentifierEffect(
          "dedupe key",
          input.dedupeKey,
          256,
        )
        const text = yield* boundedBridgeTextEffect(
          "message",
          input.text,
          MAX_REMOTE_MESSAGE_CHARACTERS,
        )
        const images = yield* boundedBridgeImagesEffect(input.images ?? [])
        const imagesJson = yield* Effect.try({
          try: () => JSON.stringify(images),
          catch: () =>
            bridgeError("invalid_input", "images are not serializable"),
        })
        const now = yield* boundedTimestampEffect("now", input.now)
        const ttlMs = yield* boundedTtlEffect(input.ttlMs)
        const expiresAt = now + ttlMs
        if (!Number.isSafeInteger(expiresAt))
          return yield* Effect.fail(
            bridgeError("invalid_input", "message expiry exceeds time range"),
          )
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            yield* expireMessagesEffect(database, now)
            yield* pruneTerminalMessagesEffect(database, now)
            if (!(yield* enabledEffect(database)))
              return yield* Effect.fail(
                bridgeError("disabled", "remote message bridge is disabled"),
              )
            const agent = yield* attempt(
              "Could not read target bridge agent",
              () =>
                database
                  .prepare(
                    "SELECT * FROM bridge_agents WHERE agent_id = ? AND expires_at > ?",
                  )
                  .get(targetAgentId, now),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (!agent)
              return yield* Effect.fail(
                bridgeError(
                  "stale_agent",
                  "target session is not bridge-ready",
                ),
              )
            const workDelivery = yield* workDeliveryFieldEffect(agent)
            if (!workDeliveryAcceptsInbox(workDelivery))
              return yield* Effect.fail(
                bridgeError(
                  "undrainable_agent",
                  `target session delivery mode ${workDelivery} cannot drain queued work`,
                ),
              )
            const existing = yield* attempt(
              "Could not read deduplicated remote message",
              () =>
                database
                  .prepare(
                    "SELECT * FROM bridge_messages WHERE requester_id = ? AND dedupe_key = ?",
                  )
                  .get(requesterId, dedupeKey),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (existing) return yield* messageFromRowEffect(existing)
            if (
              (yield* countEffect(database, "bridge_messages")) >= MAX_MESSAGES
            )
              return yield* Effect.fail(
                bridgeError("capacity", "bridge message capacity reached"),
              )
            const id = randomUUID()
            yield* attempt("Could not insert remote message", () =>
              database
                .prepare(
                  `INSERT INTO bridge_messages (
                     message_id, target_agent_id, requester_id, dedupe_key, text, images_json,
                     created_at, expires_at, updated_at, status
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
                )
                .run(
                  id,
                  targetAgentId,
                  requesterId,
                  dedupeKey,
                  text,
                  imagesJson,
                  now,
                  expiresAt,
                  now,
                ),
            )
            const row = yield* attempt(
              "Could not read enqueued remote message",
              () =>
                database
                  .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                  .get(id),
            ).pipe(Effect.flatMap(rowFromEffect))
            return yield* messageFromRowEffect(row)
          }),
        )
      }),
    ),
  claimNext: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            yield* expireMessagesEffect(database, now)
            if (!(yield* enabledEffect(database))) return undefined
            const agent = yield* attempt(
              "Could not read claiming bridge agent",
              () =>
                database
                  .prepare(
                    "SELECT * FROM bridge_agents WHERE agent_id = ? AND expires_at > ?",
                  )
                  .get(agentId, now),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (!agent)
              return yield* Effect.fail(
                bridgeError(
                  "stale_agent",
                  "claiming session is not bridge-ready",
                ),
              )
            const workDelivery = yield* workDeliveryFieldEffect(agent)
            if (!workDeliveryAcceptsInbox(workDelivery))
              return yield* Effect.fail(
                bridgeError(
                  "undrainable_agent",
                  `session delivery mode ${workDelivery} cannot drain queued work`,
                ),
              )
            const row = yield* attempt("Could not select remote message", () =>
              database
                .prepare(
                  `SELECT * FROM bridge_messages
                   WHERE target_agent_id = ? AND status = 'queued' AND expires_at > ?
                   ORDER BY created_at, message_id LIMIT 1`,
                )
                .get(agentId, now),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (!row) return undefined
            const id = yield* requiredStringFieldEffect(row, "message_id")
            const claimToken = randomUUID()
            yield* attempt("Could not claim remote message", () =>
              database
                .prepare(
                  `UPDATE bridge_messages
                   SET status = 'claimed', claim_token = ?, claimed_at = ?, updated_at = ?, expires_at = ?
                   WHERE message_id = ? AND status = 'queued'`,
                )
                .run(claimToken, now, now, now + BRIDGE_MESSAGE_TTL_MS, id),
            )
            const claimed = yield* attempt(
              "Could not read claimed remote message",
              () =>
                database
                  .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                  .get(id),
            ).pipe(Effect.flatMap(rowFromEffect))
            return yield* messageFromRowEffect(claimed)
          }),
        )
      }),
    ),
  complete: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const messageId = yield* boundedIdentifierEffect(
          "message id",
          input.messageId,
        )
        const claimToken = yield* boundedIdentifierEffect(
          "claim token",
          input.claimToken,
        )
        const response = yield* boundedBridgeTextEffect(
          "response",
          input.response,
          MAX_REMOTE_RESPONSE_CHARACTERS,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const result = yield* attempt(
              "Could not complete remote message",
              () =>
                database
                  .prepare(
                    `UPDATE bridge_messages
                   SET status = 'completed', response = ?, completed_at = ?, updated_at = ?, claim_token = NULL
                   WHERE message_id = ? AND status = 'claimed' AND claim_token = ? AND expires_at > ?`,
                  )
                  .run(response, now, now, messageId, claimToken, now),
            )
            if (result.changes !== 1)
              return yield* Effect.fail(
                bridgeError("invalid_transition", "stale remote message claim"),
              )
            const row = yield* attempt(
              "Could not read completed remote message",
              () =>
                database
                  .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                  .get(messageId),
            ).pipe(Effect.flatMap(rowFromEffect))
            return yield* messageFromRowEffect(row)
          }),
        )
      }),
    ),
  fail: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const messageId = yield* boundedIdentifierEffect(
          "message id",
          input.messageId,
        )
        const claimToken = yield* boundedIdentifierEffect(
          "claim token",
          input.claimToken,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const result = yield* attempt("Could not fail remote message", () =>
              database
                .prepare(
                  `UPDATE bridge_messages
                   SET status = 'failed', failure = ?, completed_at = ?, updated_at = ?, claim_token = NULL
                   WHERE message_id = ? AND status = 'claimed' AND claim_token = ?`,
                )
                .run(input.failure, now, now, messageId, claimToken),
            )
            if (result.changes !== 1)
              return yield* Effect.fail(
                bridgeError("invalid_transition", "stale remote message claim"),
              )
            const row = yield* attempt(
              "Could not read failed remote message",
              () =>
                database
                  .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
                  .get(messageId),
            ).pipe(Effect.flatMap(rowFromEffect))
            return yield* messageFromRowEffect(row)
          }),
        )
      }),
    ),
  get: (messageId, now) =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const id = yield* boundedIdentifierEffect("message id", messageId)
        const at = yield* boundedTimestampEffect("now", now)
        yield* expireMessagesEffect(database, at)
        const row = yield* attempt("Could not read remote message", () =>
          database
            .prepare("SELECT * FROM bridge_messages WHERE message_id = ?")
            .get(id),
        ).pipe(Effect.flatMap(optionalRowFromEffect))
        if (!row)
          return yield* Effect.fail(
            bridgeError("not_found", "remote message not found"),
          )
        return yield* messageFromRowEffect(row)
      }),
    ),
  setEnabled: value =>
    withDatabaseEffect(databasePath, database =>
      attempt("Could not update bridge state", () => {
        database
          .prepare("UPDATE bridge_settings SET value = ? WHERE key = 'enabled'")
          .run(value ? "1" : "0")
        return value
      }),
    ),
  isEnabled: () => withDatabaseEffect(databasePath, enabledEffect),
  syncQuestions: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        const questions = yield* Effect.forEach(
          input.questions,
          boundedQuestionSnapshotEffect,
        )
        const questionIds = new Set(questions.map(({ id }) => id))
        yield* transactionEffect(
          database,
          Effect.gen(function* () {
            for (const question of questions) {
              const existing = yield* attempt(
                "Could not inspect bridge question",
                () =>
                  database
                    .prepare(
                      "SELECT status FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
                    )
                    .get(agentId, question.id),
              ).pipe(Effect.flatMap(optionalRowFromEffect))
              const existingStatus = existing
                ? yield* requiredStringFieldEffect(existing, "status")
                : undefined
              const optionsJson = question.options
                ? yield* Effect.try({
                    try: () => JSON.stringify(question.options),
                    catch: () =>
                      bridgeError(
                        "invalid_input",
                        "question options are not serializable",
                      ),
                  })
                : null
              if (question.status === "pending") {
                if (
                  existingStatus === "answered" ||
                  existingStatus === "delivered"
                )
                  continue
                if (existingStatus === undefined) {
                  yield* attempt("Could not insert bridge question", () =>
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
                      ),
                  )
                  continue
                }
                const reopened = existingStatus === "resolved"
                yield* attempt("Could not update bridge question", () =>
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
                    ),
                )
                continue
              }
              yield* attempt("Could not resolve bridge question", () =>
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
                  ),
              )
              yield* attempt(
                "Could not clear conversation question delivery",
                () =>
                  database
                    .prepare(
                      `DELETE FROM bridge_question_delivery_channels
                     WHERE agent_id = ? AND question_id = ?`,
                    )
                    .run(agentId, question.id),
              )
            }
            const values = yield* attempt(
              "Could not list synced bridge questions",
              () =>
                database
                  .prepare(
                    "SELECT question_id, status FROM bridge_questions WHERE agent_id = ?",
                  )
                  .all(agentId),
            )
            const existing = yield* Effect.forEach(values, rowFromEffect)
            for (const row of existing) {
              const questionId = yield* numberFieldEffect(row, "question_id")
              const status = yield* requiredStringFieldEffect(row, "status")
              if (questionIds.has(questionId) || status === "answered") continue
              yield* attempt("Could not remove stale bridge question", () =>
                database
                  .prepare(
                    "DELETE FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
                  )
                  .run(agentId, questionId),
              )
              yield* attempt("Could not clear stale question delivery", () =>
                database
                  .prepare(
                    `DELETE FROM bridge_question_delivery_channels
                     WHERE agent_id = ? AND question_id = ?`,
                  )
                  .run(agentId, questionId),
              )
            }
          }),
        )
      }),
    ),
  listPendingQuestions: now =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const at = yield* boundedTimestampEffect("now", now)
        const rows = yield* attempt(
          "Could not list pending bridge questions",
          () =>
            database
              .prepare(
                `SELECT question.*
               FROM bridge_questions AS question
               INNER JOIN bridge_agents AS agent ON agent.agent_id = question.agent_id
               WHERE question.status = 'pending'
                 AND agent.expires_at > ?
               ORDER BY question.created_at, question.agent_id, question.question_id
               LIMIT 100`,
              )
              .all(at),
        )
        return yield* Effect.forEach(rows, row =>
          rowFromEffect(row).pipe(Effect.flatMap(questionFromRowEffect)),
        )
      }),
    ),
  listUnrelayedQuestions: now =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const at = yield* boundedTimestampEffect("now", now)
        const rows = yield* attempt(
          "Could not list unrelayed bridge questions",
          () =>
            database
              .prepare(
                `SELECT question.*
               FROM bridge_questions AS question
               INNER JOIN bridge_agents AS agent ON agent.agent_id = question.agent_id
               WHERE question.status = 'pending'
                 AND question.telegram_message_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM bridge_question_delivery_channels AS delivery
                   WHERE delivery.agent_id = question.agent_id
                     AND delivery.question_id = question.question_id
                     AND delivery.channel = 'conversation'
                 )
                 AND agent.expires_at > ?
               ORDER BY question.created_at, question.agent_id, question.question_id
               LIMIT 100`,
              )
              .all(at),
        )
        return yield* Effect.forEach(rows, row =>
          rowFromEffect(row).pipe(Effect.flatMap(questionFromRowEffect)),
        )
      }),
    ),
  isQuestionRelayed: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const questionId = yield* positiveSafeIntegerEffect(
          "question id",
          input.questionId,
        )
        const row = yield* attempt("Could not read question relay status", () =>
          database
            .prepare(
              `SELECT telegram_message_id
               FROM bridge_questions
               WHERE agent_id = ? AND question_id = ?`,
            )
            .get(agentId, questionId),
        ).pipe(Effect.flatMap(optionalRowFromEffect))
        return (
          row?.telegram_message_id !== null &&
          row?.telegram_message_id !== undefined
        )
      }),
    ),
  isQuestionHistoricallyRelayed: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const questionId = yield* positiveSafeIntegerEffect(
          "question id",
          input.questionId,
        )
        const row = yield* attempt(
          "Could not read historical question relay status",
          () =>
            database
              .prepare(
                `SELECT telegram_message_id
                 FROM bridge_question_relays
                 WHERE agent_id = ? AND question_id = ?`,
              )
              .get(agentId, questionId),
        ).pipe(Effect.flatMap(optionalRowFromEffect))
        return row !== undefined
      }),
    ),
  markQuestionDeliveredInConversation: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const questionId = yield* positiveSafeIntegerEffect(
          "question id",
          input.questionId,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const row = yield* attempt(
              "Could not read conversation-delivered question",
              () =>
                database
                  .prepare(
                    `SELECT status, telegram_message_id FROM bridge_questions
                     WHERE agent_id = ? AND question_id = ?`,
                  )
                  .get(agentId, questionId),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (!row)
              return yield* Effect.fail(
                bridgeError("not_found", "question not found for this agent"),
              )
            const status = yield* requiredStringFieldEffect(row, "status")
            if (status !== "pending" || row.telegram_message_id !== null)
              return yield* Effect.fail(
                bridgeError(
                  "invalid_transition",
                  "only a pending unlinked question can be delivered in conversation",
                ),
              )
            yield* attempt(
              "Could not persist conversation question delivery",
              () =>
                database
                  .prepare(
                    `INSERT INTO bridge_question_delivery_channels (
                       agent_id, question_id, channel, delivered_at
                     ) VALUES (?, ?, 'conversation', ?)
                     ON CONFLICT(agent_id, question_id) DO UPDATE SET
                       channel = excluded.channel,
                       delivered_at = excluded.delivered_at`,
                  )
                  .run(agentId, questionId, now),
            )
          }),
        )
      }),
    ),
  linkTelegramQuestion: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const questionId = yield* positiveSafeIntegerEffect(
          "question id",
          input.questionId,
        )
        const chatId = yield* positiveSafeIntegerEffect(
          "Telegram chat id",
          input.chatId,
        )
        const messageId = yield* positiveSafeIntegerEffect(
          "Telegram message id",
          input.messageId,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const result = yield* attempt(
              "Could not link Telegram question",
              () =>
                database
                  .prepare(
                    `UPDATE bridge_questions
                   SET telegram_chat_id = ?, telegram_message_id = ?, updated_at = ?
                   WHERE agent_id = ? AND question_id = ?
                     AND status = 'pending' AND telegram_message_id IS NULL
                     AND NOT EXISTS (
                       SELECT 1
                       FROM bridge_question_delivery_channels AS delivery
                       WHERE delivery.agent_id = bridge_questions.agent_id
                         AND delivery.question_id = bridge_questions.question_id
                         AND delivery.channel = 'conversation'
                     )`,
                  )
                  .run(chatId, messageId, now, agentId, questionId),
            )
            if (result.changes !== 1)
              return yield* Effect.fail(
                bridgeError(
                  "invalid_transition",
                  "question is already relayed or terminal",
                ),
              )
            yield* attempt("Could not retain Telegram question relay", () =>
              database
                .prepare(
                  `INSERT INTO bridge_question_relays (
                     agent_id, question_id, telegram_message_id, relayed_at
                   ) VALUES (?, ?, ?, ?)
                   ON CONFLICT(agent_id, question_id) DO NOTHING`,
                )
                .run(agentId, questionId, messageId, now),
            )
            const row = yield* attempt(
              "Could not read linked Telegram question",
              () =>
                database
                  .prepare(
                    "SELECT * FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
                  )
                  .get(agentId, questionId),
            ).pipe(Effect.flatMap(rowFromEffect))
            return yield* questionFromRowEffect(row)
          }),
        )
      }),
    ),
  answerTelegramQuestion: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const chatId = yield* positiveSafeIntegerEffect(
          "Telegram chat id",
          input.chatId,
        )
        const messageId = yield* positiveSafeIntegerEffect(
          "Telegram message id",
          input.messageId,
        )
        const rawAnswer = yield* boundedBridgeTextEffect(
          "question answer",
          input.answer,
          MAX_REMOTE_ANSWER_CHARACTERS,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const row = yield* attempt("Could not read Telegram question", () =>
              database
                .prepare(
                  `SELECT * FROM bridge_questions
                   WHERE telegram_chat_id = ? AND telegram_message_id = ?`,
                )
                .get(chatId, messageId),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (!row)
              return yield* Effect.fail(
                bridgeError("not_found", "Telegram question binding not found"),
              )
            if ((yield* requiredStringFieldEffect(row, "status")) !== "pending")
              return yield* Effect.fail(
                bridgeError(
                  "invalid_transition",
                  "Telegram question is already terminal",
                ),
              )
            const options = yield* questionOptionsFromJsonEffect(
              yield* optionalStringFieldEffect(row, "options_json"),
            )
            const optionIndex = /^[1-4]$/.test(rawAnswer)
              ? Number(rawAnswer) - 1
              : -1
            const answer = options?.[optionIndex]?.label ?? rawAnswer
            const agentId = yield* requiredStringFieldEffect(row, "agent_id")
            const questionId = yield* numberFieldEffect(row, "question_id")
            const result = yield* attempt(
              "Could not answer Telegram question",
              () =>
                database
                  .prepare(
                    `UPDATE bridge_questions
                   SET status = 'answered', answer = ?, updated_at = ?
                   WHERE agent_id = ? AND question_id = ? AND status = 'pending'`,
                  )
                  .run(answer, now, agentId, questionId),
            )
            if (result.changes !== 1)
              return yield* Effect.fail(
                bridgeError(
                  "invalid_transition",
                  "Telegram question answer raced",
                ),
              )
            yield* attempt(
              "Could not clear conversation question delivery",
              () =>
                database
                  .prepare(
                    `DELETE FROM bridge_question_delivery_channels
                   WHERE agent_id = ? AND question_id = ?`,
                  )
                  .run(agentId, questionId),
            )
            return { agentId, questionId, answer }
          }),
        )
      }),
    ),
  answerSolePendingTelegramQuestion: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const chatId = yield* positiveSafeIntegerEffect(
          "Telegram chat id",
          input.chatId,
        )
        const rawAnswer = yield* boundedBridgeTextEffect(
          "question answer",
          input.answer,
          MAX_REMOTE_ANSWER_CHARACTERS,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        if (!/^[1-4]$/.test(rawAnswer)) return undefined
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const values = yield* attempt(
              "Could not list sole pending Telegram question",
              () =>
                database
                  .prepare(
                    `SELECT * FROM bridge_questions
                     WHERE telegram_chat_id = ?
                       AND telegram_message_id IS NOT NULL
                       AND status = 'pending'
                     ORDER BY updated_at DESC, telegram_message_id DESC
                     LIMIT 2`,
                  )
                  .all(chatId),
            )
            const rows = yield* Effect.forEach(values, rowFromEffect)
            if (rows.length !== 1) return undefined
            const row = rows[0]
            if (!row) return undefined
            const options = yield* questionOptionsFromJsonEffect(
              yield* optionalStringFieldEffect(row, "options_json"),
            )
            const answer = options?.[Number(rawAnswer) - 1]?.label
            if (!answer) return undefined
            const agentId = yield* requiredStringFieldEffect(row, "agent_id")
            const questionId = yield* numberFieldEffect(row, "question_id")
            const result = yield* attempt(
              "Could not answer sole pending Telegram question",
              () =>
                database
                  .prepare(
                    `UPDATE bridge_questions
                     SET status = 'answered', answer = ?, updated_at = ?
                     WHERE agent_id = ? AND question_id = ? AND status = 'pending'`,
                  )
                  .run(answer, now, agentId, questionId),
            )
            if (result.changes !== 1)
              return yield* Effect.fail(
                bridgeError(
                  "invalid_transition",
                  "Telegram question answer raced",
                ),
              )
            yield* attempt(
              "Could not clear conversation question delivery",
              () =>
                database
                  .prepare(
                    `DELETE FROM bridge_question_delivery_channels
                   WHERE agent_id = ? AND question_id = ?`,
                  )
                  .run(agentId, questionId),
            )
            return { agentId, questionId, answer }
          }),
        )
      }),
    ),
  dismissQuestion: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const questionId = yield* positiveSafeIntegerEffect(
          "question id",
          input.questionId,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const existing = yield* attempt(
              "Could not read bridge question",
              () =>
                database
                  .prepare(
                    "SELECT * FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
                  )
                  .get(agentId, questionId),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (!existing)
              return yield* Effect.fail(
                bridgeError("not_found", "question not found for this agent"),
              )
            if (
              (yield* requiredStringFieldEffect(existing, "status")) ===
              "answered"
            )
              return yield* Effect.fail(
                bridgeError(
                  "invalid_transition",
                  "question is answered; collect it with answer instead",
                ),
              )
            yield* attempt("Could not dismiss bridge question", () =>
              database
                .prepare(
                  `UPDATE bridge_questions
                   SET status = 'resolved', updated_at = ?
                   WHERE agent_id = ? AND question_id = ? AND status = 'pending'`,
                )
                .run(now, agentId, questionId),
            )
            yield* attempt(
              "Could not clear conversation question delivery",
              () =>
                database
                  .prepare(
                    `DELETE FROM bridge_question_delivery_channels
                   WHERE agent_id = ? AND question_id = ?`,
                  )
                  .run(agentId, questionId),
            )
            const row = yield* attempt(
              "Could not read dismissed bridge question",
              () =>
                database
                  .prepare(
                    "SELECT * FROM bridge_questions WHERE agent_id = ? AND question_id = ?",
                  )
                  .get(agentId, questionId),
            ).pipe(Effect.flatMap(rowFromEffect))
            return yield* questionFromRowEffect(row)
          }),
        )
      }),
    ),
  takeQuestionResolution: input =>
    withDatabaseEffect(databasePath, database =>
      Effect.gen(function* () {
        const agentId = yield* boundedIdentifierEffect(
          "agent id",
          input.agentId,
        )
        const now = yield* boundedTimestampEffect("now", input.now)
        return yield* transactionEffect(
          database,
          Effect.gen(function* () {
            const row = yield* attempt(
              "Could not read question resolution",
              () =>
                database
                  .prepare(
                    `SELECT * FROM bridge_questions
                   WHERE agent_id = ? AND status = 'answered'
                   ORDER BY updated_at, question_id
                   LIMIT 1`,
                  )
                  .get(agentId),
            ).pipe(Effect.flatMap(optionalRowFromEffect))
            if (!row) return undefined
            const questionId = yield* numberFieldEffect(row, "question_id")
            const result = yield* attempt(
              "Could not take question resolution",
              () =>
                database
                  .prepare(
                    `UPDATE bridge_questions
                   SET status = 'delivered', updated_at = ?
                   WHERE agent_id = ? AND question_id = ? AND status = 'answered'`,
                  )
                  .run(now, agentId, questionId),
            )
            if (result.changes !== 1)
              return yield* Effect.fail(
                bridgeError(
                  "invalid_transition",
                  "question resolution delivery raced",
                ),
              )
            return yield* resolutionFromRowEffect(row)
          }),
        )
      }),
    ),
})
