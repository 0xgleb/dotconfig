import { createHash, randomUUID } from "node:crypto"
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Cause, Data, Effect, Either, Exit, Option, Schema } from "effect"
import {
  decodeIssueReference,
  issueKey,
  type IssueReference,
} from "./identity.ts"
import {
  TaskIdSchema,
  RevisionSchema,
  TextSchema,
  StatusSchema,
  type IssueTaskRevision,
  type IssueTaskPage,
  type TaskPageInput,
  MutationBatchIdSchema,
  type MutationBatchId,
  type TaskId,
} from "./model.ts"
import {
  decodeTaskMutationBatch,
  DraftKeySchema,
  MAX_TASK_MUTATIONS,
  MAX_TASK_DEPENDENCIES,
  type TaskMutationError,
  type TaskMutationBatch,
  type TaskReference,
} from "./mutations.ts"
import {
  prepareTaskChanges,
  MAX_TRANSITION_NODES,
  MAX_TRANSITION_EDGES,
  MAX_TRANSITION_TEXT,
  type CurrentTask,
  type DependencyNode,
  type IssueCandidate,
  type TaskSnapshot,
  type PreparedTaskChanges,
  type TaskTransitionError,
  type TaskIdAllocation,
  type TaskChangeSummary,
  type TaskMutationContext,
} from "./transition.ts"

const StorageIssueIdSchema = Schema.UUID.pipe(
  Schema.brand("StorageIssueRowId"),
  Schema.filter(value => value === value.toLowerCase()),
)
type StorageIssueId = typeof StorageIssueIdSchema.Type
interface StoredIssueRow extends IssueTaskRevision {
  readonly id: StorageIssueId
}

const PageSchema = Schema.Struct({
  limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
  after: Schema.optional(TaskIdSchema),
})
const PlanRowSchema = Schema.Struct({
  id: StorageIssueIdSchema,
  repository: Schema.String,
  issue_number: Schema.Number,
  revision: RevisionSchema,
})
const TaskRowSchema = Schema.Struct({
  id: TaskIdSchema,
  text: TextSchema,
  status: StatusSchema,
  blocker: Schema.NullOr(TextSchema),
})

export type {
  TaskId,
  TaskStatus,
  IssueTaskRevision,
  IssueTask,
  IssueTaskPage,
  TaskPageInput,
} from "./model.ts"

export class TaskStoreError extends Data.TaggedError("TaskStoreError")<{
  readonly code:
    | "invalid_input"
    | "invalid_path"
    | "unsupported_schema"
    | "corrupt_state"
    | "busy"
    | "capacity"
    | "closed"
    | "io"
  readonly message: string
}> {}

export interface TaskApplyContext {
  readonly actorId: string
  readonly requestId: string
  readonly now: number
  readonly cancellation: TaskMutationContext["cancellation"]
}
export interface TaskApplyResult {
  readonly kind: "saved"
  readonly receipt: "committed" | "replayed" | "recovered"
  readonly batchId: MutationBatchId
  readonly issues: readonly IssueTaskRevision[]
  readonly changed: readonly TaskChangeSummary[]
  readonly created: readonly TaskIdAllocation[]
  readonly eventCount: number
}
export class TaskRequestConflictError extends Data.TaggedError(
  "TaskRequestConflictError",
)<{
  readonly code: "request_conflict"
  readonly message: string
}> {}
export class TaskCommitUnknownError extends Data.TaggedError(
  "TaskCommitUnknownError",
)<{
  readonly code: "unknown_completion"
  readonly batchId: MutationBatchId
  readonly requestId: string
  readonly message: string
  readonly cause: unknown
}> {}
export type TaskApplyError =
  | TaskStoreError
  | TaskMutationError
  | TaskTransitionError
  | TaskRequestConflictError
  | TaskCommitUnknownError

export interface SqliteTaskStore {
  readonly apply: (
    input: unknown,
    context: TaskApplyContext,
  ) => Effect.Effect<TaskApplyResult, TaskApplyError>
  readonly readTasks: (
    issue: IssueReference,
    page: TaskPageInput,
  ) => StoreEffect<Option.Option<IssueTaskPage>>
  readonly close: () => StoreEffect<void>
}
export interface SqliteTaskStoreOptions {
  readonly databasePath: string
  readonly busyTimeoutMs?: number
  // Deterministic transaction barrier for fixture interruption tests only.
  readonly taskTransactionBeginSignal?: Effect.Effect<void, TaskStoreError>
}

type StoreEffect<A> = Effect.Effect<A, TaskStoreError>
interface ValidatedPlanStoreOptions {
  readonly databasePath: string
  readonly busyTimeoutMs: number
  readonly taskTransactionBeginSignal:
    Effect.Effect<void, TaskStoreError> | undefined
}
type ConnectionState = "open" | "unusable" | "closed"

const schemaDeclarations = [
  {
    name: "issue_plan_schema",
    type: "table",
    sql: `CREATE TABLE issue_plan_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL CHECK (version >= 1)
      ) STRICT`,
  },
  {
    name: "issue_plans",
    type: "table",
    sql: `CREATE TABLE issue_plans (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL CHECK (issue_number BETWEEN 1 AND 9007199254740991),
        revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
        UNIQUE (repository, issue_number)
      ) STRICT`,
  },
  {
    name: "issue_plan_tasks",
    type: "table",
    sql: `CREATE TABLE issue_plan_tasks (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES issue_plans(id),
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 131072),
        status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done', 'cancelled')),
        blocker TEXT
      ) STRICT`,
  },
  {
    name: "issue_plan_tasks_by_plan",
    type: "index",
    sql: "CREATE INDEX issue_plan_tasks_by_plan ON issue_plan_tasks (plan_id, id)",
  },
] as const

const mutationSchemaDeclarations = [
  {
    name: "issue_plan_dependencies",
    type: "table",
    sql: `CREATE TABLE issue_plan_dependencies (
    task_id TEXT NOT NULL REFERENCES issue_plan_tasks(id),
    depends_on_id TEXT NOT NULL REFERENCES issue_plan_tasks(id),
    PRIMARY KEY (task_id, depends_on_id),
    CHECK (task_id <> depends_on_id)
  ) STRICT`,
  },
  {
    name: "issue_plan_batches",
    type: "table",
    sql: `CREATE TABLE issue_plan_batches (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    recorded_at INTEGER NOT NULL CHECK (recorded_at BETWEEN 0 AND 9007199254740991),
    result_json TEXT NOT NULL,
    UNIQUE (actor_id, request_id)
  ) STRICT`,
  },
  {
    name: "issue_plan_history",
    type: "table",
    sql: `CREATE TABLE issue_plan_history (
    sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9007199254740991),
    batch_id TEXT NOT NULL REFERENCES issue_plan_batches(id),
    plan_id TEXT NOT NULL REFERENCES issue_plans(id),
    task_id TEXT NOT NULL REFERENCES issue_plan_tasks(id),
    operation_index INTEGER NOT NULL CHECK (operation_index BETWEEN 0 AND 999),
    kind TEXT NOT NULL CHECK (kind IN ('add', 'edit', 'status', 'block')),
    recorded_at INTEGER NOT NULL CHECK (recorded_at BETWEEN 0 AND 9007199254740991),
    payload_json TEXT NOT NULL,
    UNIQUE (batch_id, operation_index)
  ) STRICT`,
  },
  {
    name: "issue_plan_history_by_task",
    type: "index",
    sql: "CREATE INDEX issue_plan_history_by_task ON issue_plan_history (task_id, sequence)",
  },
] as const
const transferHistoryDeclaration = {
  name: "issue_plan_history",
  type: "table",
  sql: `CREATE TABLE issue_plan_history (
    sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 9007199254740991),
    batch_id TEXT NOT NULL REFERENCES issue_plan_batches(id),
    plan_id TEXT NOT NULL REFERENCES issue_plans(id),
    task_id TEXT NOT NULL REFERENCES issue_plan_tasks(id),
    operation_index INTEGER NOT NULL CHECK (operation_index BETWEEN 0 AND 999),
    kind TEXT NOT NULL CHECK (kind IN ('add', 'edit', 'status', 'block', 'transfer')),
    recorded_at INTEGER NOT NULL CHECK (recorded_at BETWEEN 0 AND 9007199254740991),
    payload_json TEXT NOT NULL,
    UNIQUE (batch_id, operation_index)
  ) STRICT`,
} as const
const currentMutationSchemaDeclarations = mutationSchemaDeclarations.map(
  entry =>
    entry.name === "issue_plan_history" ? transferHistoryDeclaration : entry,
)
const versionTwoSchemaDeclarations = [
  ...schemaDeclarations,
  ...mutationSchemaDeclarations,
]
const versionThreeSchemaDeclarations = [
  ...schemaDeclarations,
  ...currentMutationSchemaDeclarations,
]
const qualifiedIssueIndexDeclaration = {
  name: "issue_plan_issues_nocase",
  type: "index",
  sql: "CREATE INDEX issue_plan_issues_nocase ON issue_plans (repository COLLATE NOCASE, issue_number)",
} as const
const currentSchemaDeclarations = [
  ...versionThreeSchemaDeclarations,
  qualifiedIssueIndexDeclaration,
]
const SCHEMA_VERSION = 4
const SchemaObjectSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  sql: Schema.NullOr(Schema.String),
})
type SchemaObject = typeof SchemaObjectSchema.Type

const normalizedDeclaration = (sql: string): string =>
  sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "")

const fail = (
  code: TaskStoreError["code"],
  message: string,
): StoreEffect<never> => Effect.fail(new TaskStoreError({ code, message }))

const io = <A>(message: string, operation: () => A): StoreEffect<A> =>
  Effect.try({
    try: operation,
    catch: error =>
      new TaskStoreError({
        code:
          error instanceof Error &&
          /database (?:is (?:busy|locked)|table is locked)/iu.test(
            error.message,
          )
            ? "busy"
            : "io",
        message,
      }),
  })

const decode = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  code: TaskStoreError["code"],
  message: string,
): StoreEffect<A> =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new TaskStoreError({ code, message })),
  )

const checkedIssue = (
  value: unknown,
  code: "invalid_input" | "corrupt_state",
): StoreEffect<IssueReference> => {
  const result = decodeIssueReference(value)
  return Either.isLeft(result)
    ? fail(code, "Invalid repository-qualified issue identity")
    : Effect.succeed(result.right)
}

const planFrom = (value: unknown): StoreEffect<StoredIssueRow> =>
  Effect.gen(function* () {
    const row = yield* decode(
      PlanRowSchema,
      value,
      "corrupt_state",
      "Invalid persisted issue task state",
    )
    const issue = yield* checkedIssue(
      { repository: row.repository, number: row.issue_number },
      "corrupt_state",
    )
    if (issue.repository !== row.repository)
      return yield* fail(
        "corrupt_state",
        "Persisted repository is not canonical",
      )
    return Object.freeze({ id: row.id, issue, revision: row.revision })
  })

const retryBusy = <A>(
  operation: StoreEffect<A>,
  remaining = 2,
): StoreEffect<A> =>
  operation.pipe(
    Effect.catchIf(
      error => error.code === "busy" && remaining > 0,
      () =>
        Effect.sleep("25 millis").pipe(
          Effect.andThen(
            Effect.suspend(() => retryBusy(operation, remaining - 1)),
          ),
        ),
    ),
  )

const transaction = <A, E, F = never>(
  database: DatabaseSync,
  mode: "read" | "write",
  work: Effect.Effect<A, E>,
  poison: () => void = () => {},
  recoverCommit?: (
    value: A,
    cause: Cause.Cause<TaskStoreError>,
  ) => Effect.Effect<A, F>,
): Effect.Effect<A, E | F | TaskStoreError> =>
  Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      yield* retryBusy(
        io("Could not begin task transaction", () =>
          database.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN"),
        ),
      )
      const worked = yield* Effect.exit(restore(work))
      if (Exit.isFailure(worked)) {
        const rollback = yield* Effect.exit(
          io("Could not roll back task transaction", () =>
            database.exec("ROLLBACK"),
          ),
        )
        if (Exit.isFailure(rollback)) {
          poison()
          return yield* Effect.failCause(
            Cause.sequential(worked.cause, rollback.cause),
          )
        }
        return yield* Effect.failCause(worked.cause)
      }

      const committed = yield* Effect.exit(
        io("Could not commit task transaction", () => database.exec("COMMIT")),
      )
      if (Exit.isSuccess(committed)) return worked.value

      const rollback = yield* Effect.exit(
        io("Could not roll back task transaction", () =>
          database.exec("ROLLBACK"),
        ),
      )
      if (Exit.isFailure(rollback)) {
        poison()
        const cause = Cause.sequential(committed.cause, rollback.cause)
        return yield* recoverCommit === undefined
          ? Effect.failCause(cause)
          : recoverCommit(worked.value, cause)
      }
      return yield* Effect.failCause(committed.cause)
    }),
  )

class FileExists extends Data.TaggedError("FileExists") {}

const secureFile = (
  path: string,
  mode: "create" | "existing" = "create",
): StoreEffect<void> =>
  Effect.gen(function* () {
    if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path))
      return yield* fail(
        "invalid_path",
        "Database path must be absolute and normalized",
      )
    const getuid = process.getuid
    if (typeof getuid !== "function")
      return yield* fail(
        "invalid_path",
        "Database ownership requires Unix filesystem support",
      )
    const parent = dirname(path)
    const metadata = yield* io("Could not inspect database directory", () => ({
      canonical: realpathSync(parent),
      directory: lstatSync(parent),
      uid: getuid(),
    }))
    if (
      metadata.canonical !== parent ||
      !metadata.directory.isDirectory() ||
      metadata.directory.uid !== metadata.uid ||
      (metadata.directory.mode & 0o022) !== 0
    )
      return yield* fail(
        "invalid_path",
        "Database directory must be canonical and writable only by its owner",
      )
    if (mode === "create") {
      const descriptor = yield* Effect.try({
        try: () => openSync(path, "wx", 0o600),
        catch: error =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
            ? new FileExists()
            : new TaskStoreError({
                code: "io",
                message: "Could not create private database file",
              }),
      }).pipe(Effect.catchTag("FileExists", () => Effect.succeed(undefined)))
      if (descriptor !== undefined)
        yield* io("Could not close new database file", () =>
          closeSync(descriptor),
        )
    }
    const file = yield* io("Could not inspect database file", () =>
      lstatSync(path),
    )
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.uid !== metadata.uid ||
      (file.mode & 0o7777) !== 0o600
    )
      return yield* fail(
        "invalid_path",
        "Database must be an owner-private regular file, not a symlink",
      )
  })

const namespaceObjects = (
  database: DatabaseSync,
): StoreEffect<readonly SchemaObject[]> =>
  Effect.gen(function* () {
    const names = currentSchemaDeclarations.map(entry => entry.name)
    const raw = yield* io("Could not inspect task schema", () =>
      database
        .prepare(
          `SELECT name, type, sql FROM sqlite_schema WHERE name COLLATE NOCASE IN (${names.map(() => "?").join(",")})`,
        )
        .all(...names),
    )
    return yield* decode(
      Schema.Array(SchemaObjectSchema),
      raw,
      "unsupported_schema",
      "Invalid task schema metadata",
    )
  })

const readSchemaVersion = (database: DatabaseSync): StoreEffect<number> =>
  Effect.gen(function* () {
    const raw = yield* io("Could not read task schema version", () =>
      database
        .prepare("SELECT id, version FROM issue_plan_schema LIMIT 2")
        .all(),
    )
    const rows = yield* decode(
      Schema.Array(
        Schema.Struct({ id: Schema.Literal(1), version: RevisionSchema }),
      ),
      raw,
      "unsupported_schema",
      "Invalid task schema version",
    )
    const first = rows[0]
    if (rows.length !== 1 || first === undefined)
      return yield* fail(
        "unsupported_schema",
        "Invalid issue-task schema version row",
      )
    return first.version
  })

const checkNamespace = (
  database: DatabaseSync,
  objects: readonly SchemaObject[],
): StoreEffect<1 | 2 | 3 | typeof SCHEMA_VERSION | undefined> =>
  Effect.gen(function* () {
    if (objects.length === 0) return undefined
    const metadata = objects.find(object => object.name === "issue_plan_schema")
    if (
      metadata === undefined ||
      metadata.type !== "table" ||
      metadata.sql === null ||
      normalizedDeclaration(metadata.sql) !==
        normalizedDeclaration(schemaDeclarations[0].sql)
    )
      return yield* fail(
        "unsupported_schema",
        "Unversioned or conflicting issue-task namespace",
      )
    const version = yield* readSchemaVersion(database)
    if (
      version !== 1 &&
      version !== 2 &&
      version !== 3 &&
      version !== SCHEMA_VERSION
    )
      return yield* fail(
        "unsupported_schema",
        "Unsupported issue-task schema version",
      )
    const expected =
      version === 1
        ? schemaDeclarations
        : version === 2
          ? versionTwoSchemaDeclarations
          : version === 3
            ? versionThreeSchemaDeclarations
            : currentSchemaDeclarations
    if (objects.length !== expected.length)
      return yield* fail(
        "unsupported_schema",
        "Incomplete or conflicting issue-task schema",
      )
    for (const actual of objects) {
      const declaration = expected.find(entry => entry.name === actual.name)
      if (
        declaration === undefined ||
        actual.type !== declaration.type ||
        actual.sql === null ||
        normalizedDeclaration(actual.sql) !==
          normalizedDeclaration(declaration.sql)
      )
        return yield* fail(
          "unsupported_schema",
          "Incompatible issue-task schema constraints",
        )
    }
    return version
  })

const checkVersion = (database: DatabaseSync): StoreEffect<void> =>
  Effect.gen(function* () {
    const version = yield* checkNamespace(
      database,
      yield* namespaceObjects(database),
    )
    if (version !== SCHEMA_VERSION)
      return yield* fail(
        "unsupported_schema",
        "Issue-task schema changed while this connection was open",
      )
  })

const migrate = (database: DatabaseSync): StoreEffect<void> =>
  Effect.gen(function* () {
    const observed = yield* checkNamespace(
      database,
      yield* namespaceObjects(database),
    )
    if (observed === SCHEMA_VERSION) return
    yield* transaction(
      database,
      "write",
      Effect.gen(function* () {
        const current = yield* checkNamespace(
          database,
          yield* namespaceObjects(database),
        )
        if (current === SCHEMA_VERSION) return
        if (current === undefined) {
          yield* io("Could not create issue-task schema", () =>
            database.exec(
              `${currentSchemaDeclarations.map(entry => entry.sql).join(";\n")};\nINSERT INTO issue_plan_schema (id, version) VALUES (1, ${SCHEMA_VERSION});`,
            ),
          )
        } else if (current === 1) {
          yield* io("Could not upgrade issue-task schema", () =>
            database.exec(
              `${currentMutationSchemaDeclarations.map(entry => entry.sql).join(";\n")};\n${qualifiedIssueIndexDeclaration.sql};\nUPDATE issue_plan_schema SET version = ${SCHEMA_VERSION} WHERE id = 1;`,
            ),
          )
        } else if (current === 2) {
          const dependent = yield* io(
            "Could not inspect history schema dependencies",
            () =>
              database
                .prepare(
                  "SELECT name FROM sqlite_schema WHERE (tbl_name = 'issue_plan_history' COLLATE NOCASE AND sql IS NOT NULL AND name NOT IN ('issue_plan_history', 'issue_plan_history_by_task')) OR (type IN ('view', 'trigger') AND instr(lower(sql), 'issue_plan_history') > 0) LIMIT 1",
                )
                .get(),
          )
          const foreignKey = yield* io(
            "Could not inspect history foreign keys",
            () =>
              database
                .prepare(
                  "SELECT s.name FROM sqlite_schema AS s JOIN pragma_foreign_key_list(s.name) AS f WHERE s.type = 'table' AND f.\"table\" = 'issue_plan_history' COLLATE NOCASE LIMIT 1",
                )
                .get(),
          )
          if (dependent !== undefined || foreignKey !== undefined)
            return yield* fail(
              "unsupported_schema",
              "History upgrade cannot preserve foreign schema dependencies",
            )
          const index = currentMutationSchemaDeclarations.find(
            entry => entry.name === "issue_plan_history_by_task",
          )
          if (index === undefined)
            return yield* fail(
              "unsupported_schema",
              "History upgrade has no index declaration",
            )
          yield* io("Could not upgrade task history schema", () =>
            database.exec(
              `ALTER TABLE issue_plan_history RENAME TO issue_plan_history_upgrade_source;\nDROP INDEX issue_plan_history_by_task;\n${transferHistoryDeclaration.sql};\nINSERT INTO issue_plan_history (sequence, batch_id, plan_id, task_id, operation_index, kind, recorded_at, payload_json) SELECT sequence, batch_id, plan_id, task_id, operation_index, kind, recorded_at, payload_json FROM issue_plan_history_upgrade_source;\nDROP TABLE issue_plan_history_upgrade_source;\n${index.sql};\n${qualifiedIssueIndexDeclaration.sql};\nUPDATE issue_plan_schema SET version = ${SCHEMA_VERSION} WHERE id = 1;`,
            ),
          )
        } else {
          yield* io("Could not upgrade qualified issue lookup", () =>
            database.exec(
              `${qualifiedIssueIndexDeclaration.sql};\nUPDATE issue_plan_schema SET version = ${SCHEMA_VERSION} WHERE id = 1;`,
            ),
          )
        }
        yield* checkVersion(database)
      }),
    )
  })

const initialize = (
  database: DatabaseSync,
  timeout: number,
): StoreEffect<void> =>
  Effect.gen(function* () {
    yield* io("Could not configure task-store connection", () =>
      database.exec(
        `PRAGMA busy_timeout = ${timeout}; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`,
      ),
    )
    const existing = yield* namespaceObjects(database)
    if (existing.length !== 0) yield* checkNamespace(database, existing)
    yield* migrate(database)
    const journal = yield* io("Could not read database journal mode", () =>
      database.prepare("PRAGMA journal_mode").get(),
    )
    const row = yield* decode(
      Schema.Struct({ journal_mode: Schema.String }),
      journal,
      "corrupt_state",
      "Invalid journal mode",
    )
    if (row.journal_mode !== "wal") {
      const configured = yield* retryBusy(
        io("Could not enable database WAL", () =>
          database.prepare("PRAGMA journal_mode = WAL").get(),
        ),
      )
      const result = yield* decode(
        Schema.Struct({ journal_mode: Schema.Literal("wal") }),
        configured,
        "io",
        "WAL could not be enabled",
      )
      if (result.journal_mode !== "wal")
        return yield* fail("io", "WAL could not be enabled")
    }
  })

const ContextSchema = Schema.Struct({
  actorId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(512),
    Schema.pattern(/^[^\u0000-\u001f\u007f]+$/u),
  ),
  requestId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(256),
    Schema.pattern(/^[^\u0000-\u001f\u007f]+$/u),
  ),
  now: RevisionSchema,
  cancellation: Schema.Literal("forbidden", "owner-authorized"),
})
const SavedResultSchema = Schema.Struct({
  kind: Schema.Literal("saved"),
  receipt: Schema.Literal("committed"),
  batchId: MutationBatchIdSchema,
  plans: Schema.Array(
    Schema.Struct({
      id: StorageIssueIdSchema,
      issue: Schema.Unknown,
      revision: RevisionSchema,
    }),
  ),
  changed: Schema.Array(
    Schema.Struct({
      issue: Schema.Unknown,
      id: TaskIdSchema,
      revision: RevisionSchema,
      fields: Schema.Array(
        Schema.Literal("text", "status", "blocker", "dependsOn", "issue"),
      ),
    }),
  ),
  created: Schema.Array(
    Schema.Struct({
      issue: Schema.Unknown,
      key: DraftKeySchema,
      id: TaskIdSchema,
    }),
  ),
  eventCount: RevisionSchema,
})
type ChangedField = TaskChangeSummary["fields"][number]
const MAX_TRANSFER_EVENT_TEXT = 4_096
const MAX_EDIT_EVENT_TEXT = 2_097_152
const EditEventSchema = Schema.Struct({
  op: Schema.Literal("edit"),
  operationIndex: RevisionSchema,
  issue: Schema.Unknown,
  id: TaskIdSchema,
  changes: Schema.Array(
    Schema.Union(
      Schema.Struct({
        field: Schema.Literal("text"),
        before: TextSchema,
        after: TextSchema,
      }),
      Schema.Struct({
        field: Schema.Literal("dependsOn"),
        before: Schema.Array(TaskIdSchema).pipe(
          Schema.maxItems(MAX_TASK_DEPENDENCIES),
        ),
        after: Schema.Array(TaskIdSchema).pipe(
          Schema.maxItems(MAX_TASK_DEPENDENCIES),
        ),
      }),
    ),
  ).pipe(Schema.minItems(1), Schema.maxItems(2)),
})
const StatusEventSchema = Schema.Struct({
  op: Schema.Literal("status"),
  operationIndex: RevisionSchema,
  issue: Schema.Unknown,
  id: TaskIdSchema,
  before: StatusSchema,
  after: StatusSchema,
})
const BlockEventSchema = Schema.Struct({
  op: Schema.Literal("block"),
  operationIndex: RevisionSchema,
  issue: Schema.Unknown,
  id: TaskIdSchema,
  before: Schema.NullOr(TextSchema),
  after: Schema.NullOr(TextSchema),
})
const TransferEventSchema = Schema.Struct({
  op: Schema.Literal("transfer"),
  operationIndex: RevisionSchema,
  issue: Schema.Unknown,
  id: TaskIdSchema,
  splitFrom: Schema.Unknown,
})
const decodeEventPayload = <A, I>(
  schema: Schema.Schema<A, I>,
  json: string | null,
): StoreEffect<A> =>
  Effect.gen(function* () {
    if (json === null)
      return yield* fail(
        "corrupt_state",
        "Task history has no bounded change payload",
      )
    const raw: unknown = yield* io("Could not decode task history", () =>
      JSON.parse(json),
    ).pipe(
      Effect.catchAll(() => fail("corrupt_state", "Invalid task history JSON")),
    )
    return yield* decode(
      schema,
      raw,
      "corrupt_state",
      "Invalid task history event",
    )
  })

const encodedJson = (value: unknown): StoreEffect<string> =>
  Effect.gen(function* () {
    const encoded = yield* io("Could not encode task data", () =>
      JSON.stringify(value),
    )
    if (encoded === undefined)
      return yield* fail(
        "corrupt_state",
        "Task data has no JSON representation",
      )
    return encoded
  })
const storedIssue = (value: unknown): StoreEffect<IssueReference> =>
  Effect.gen(function* () {
    const issue = yield* checkedIssue(value, "corrupt_state")
    if (
      typeof value !== "object" ||
      value === null ||
      !("repository" in value) ||
      value.repository !== issue.repository
    )
      return yield* fail(
        "corrupt_state",
        "Stored issue identity is not canonical",
      )
    return issue
  })
const findPlan = (
  database: DatabaseSync,
  issue: IssueReference,
): StoreEffect<Option.Option<StoredIssueRow>> =>
  Effect.gen(function* () {
    const rows = yield* io("Could not read qualified issue task state", () =>
      database
        .prepare(
          "SELECT id, repository, issue_number, revision FROM issue_plans WHERE repository = ? COLLATE NOCASE AND issue_number = ? LIMIT 2",
        )
        .all(issue.repository, issue.number),
    )
    if (rows.length > 1)
      return yield* fail(
        "corrupt_state",
        "Multiple issue records match the canonical issue identity",
      )
    const first = rows[0]
    return first === undefined
      ? Option.none()
      : Option.some(yield* planFrom(first))
  })

const readReceipt = (
  database: DatabaseSync,
  batch: TaskMutationBatch,
  context: TaskApplyContext,
  fingerprint: string,
): Effect.Effect<
  Option.Option<TaskApplyResult>,
  TaskStoreError | TaskRequestConflictError
> =>
  Effect.gen(function* () {
    const raw = yield* io("Could not read task request receipt", () =>
      database
        .prepare(
          "SELECT id, fingerprint, result_json FROM issue_plan_batches WHERE actor_id = ? AND request_id = ?",
        )
        .get(context.actorId, context.requestId),
    )
    if (raw === undefined) return Option.none()
    const row = yield* decode(
      Schema.Struct({
        id: MutationBatchIdSchema,
        fingerprint: Schema.String,
        result_json: Schema.String.pipe(Schema.maxLength(1_048_576)),
      }),
      raw,
      "corrupt_state",
      "Invalid task receipt",
    )
    if (row.fingerprint !== fingerprint)
      return yield* Effect.fail(
        new TaskRequestConflictError({
          code: "request_conflict",
          message:
            "This host request identity already belongs to different task intent or authority",
        }),
      )
    const parsed: unknown = yield* io("Could not decode task receipt", () =>
      JSON.parse(row.result_json),
    )
    const saved = yield* decode(
      SavedResultSchema,
      parsed,
      "corrupt_state",
      "Invalid saved task result",
    )
    if (
      saved.batchId !== row.id ||
      saved.eventCount > batch.operations.length ||
      saved.changed.length > MAX_TASK_MUTATIONS ||
      saved.created.length > MAX_TASK_MUTATIONS ||
      saved.plans.length > batch.issues.length
    )
      return yield* fail(
        "corrupt_state",
        "Task receipt counts or identity disagree",
      )
    const scope = new Set(batch.issues.map(issueKey))
    const plans: StoredIssueRow[] = []
    const revisions = new Map<string, number>()
    for (const plan of saved.plans) {
      const issue = yield* storedIssue(plan.issue)
      const key = issueKey(issue)
      if (!scope.has(key) || revisions.has(key))
        return yield* fail(
          "corrupt_state",
          "Task receipt issue scope is invalid",
        )
      revisions.set(key, plan.revision)
      plans.push(Object.freeze({ id: plan.id, issue, revision: plan.revision }))
    }
    const changed: TaskChangeSummary[] = []
    const taskIds = new Set<TaskId>()
    for (const task of saved.changed) {
      const issue = yield* storedIssue(task.issue)
      const key = issueKey(issue)
      if (
        !scope.has(key) ||
        revisions.get(key) !== task.revision ||
        taskIds.has(task.id) ||
        task.fields.length === 0 ||
        task.fields.length > 5 ||
        new Set(task.fields).size !== task.fields.length
      )
        return yield* fail(
          "corrupt_state",
          "Task receipt change projection is invalid",
        )
      taskIds.add(task.id)
      changed.push(
        Object.freeze({
          issue,
          id: task.id,
          revision: task.revision,
          fields: Object.freeze([...task.fields]),
        }),
      )
    }
    const expected = new Set(
      batch.operations.flatMap(operation =>
        operation.op === "add"
          ? [
              `${operation.issue.repository}#${operation.issue.number}:${operation.key}`,
            ]
          : [],
      ),
    )
    const created: TaskIdAllocation[] = []
    const createdIds = new Set<TaskId>()
    for (const task of saved.created) {
      const issue = yield* storedIssue(task.issue)
      const key = `${issue.repository}#${issue.number}:${task.key}`
      if (
        !expected.delete(key) ||
        !taskIds.has(task.id) ||
        createdIds.has(task.id)
      )
        return yield* fail(
          "corrupt_state",
          "Task receipt creation projection is invalid",
        )
      createdIds.add(task.id)
      created.push(Object.freeze({ issue, key: task.key, id: task.id }))
    }
    if (expected.size !== 0)
      return yield* fail(
        "corrupt_state",
        "Task receipt omitted generated task identities",
      )
    const planIds = new Map(plans.map(plan => [issueKey(plan.issue), plan.id]))
    for (const plan of plans) {
      const current = yield* findPlan(database, plan.issue)
      if (
        Option.isNone(current) ||
        current.value.id !== plan.id ||
        current.value.revision < plan.revision
      )
        return yield* fail(
          "corrupt_state",
          "Task receipt disagrees with its stored issue revision",
        )
    }

    const historyRows = yield* io(
      "Could not reconcile task receipt history",
      () =>
        database
          .prepare(
            `SELECT h.plan_id, h.task_id, h.operation_index, h.kind, t.id AS persisted_task_id, CASE WHEN h.kind = 'transfer' AND length(h.payload_json) <= ${MAX_TRANSFER_EVENT_TEXT} THEN h.payload_json ELSE NULL END AS transfer_payload, CASE WHEN h.kind = 'edit' THEN substr(h.payload_json, 1, ${MAX_EDIT_EVENT_TEXT + 1}) ELSE NULL END AS edit_payload, CASE WHEN h.kind IN ('status', 'block') THEN substr(h.payload_json, 1, ${MAX_EDIT_EVENT_TEXT + 1}) ELSE NULL END AS state_payload FROM issue_plan_history h LEFT JOIN issue_plan_tasks t ON t.id = h.task_id WHERE h.batch_id = ? ORDER BY h.operation_index LIMIT ?`,
          )
          .all(saved.batchId, MAX_TASK_MUTATIONS + 1),
    )
    if (historyRows.length !== saved.eventCount)
      return yield* fail(
        "corrupt_state",
        "Task receipt event count disagrees with persisted history",
      )

    const changesById = new Map(changed.map(task => [task.id, task]))
    const recordedTasks = new Set<TaskId>()
    const recordedOperations = new Set<number>()
    const recordedFields = new Map<TaskId, Set<ChangedField>>()
    const recordedIssues = new Set<string>()
    const locations = new Map<TaskId, IssueReference>()
    for (const rawHistory of historyRows) {
      const history = yield* decode(
        Schema.Struct({
          plan_id: StorageIssueIdSchema,
          task_id: TaskIdSchema,
          operation_index: RevisionSchema,
          kind: Schema.Literal("add", "edit", "status", "block", "transfer"),
          persisted_task_id: Schema.NullOr(TaskIdSchema),
          transfer_payload: Schema.NullOr(
            Schema.String.pipe(Schema.maxLength(MAX_TRANSFER_EVENT_TEXT)),
          ),
          edit_payload: Schema.NullOr(
            Schema.String.pipe(Schema.maxLength(MAX_EDIT_EVENT_TEXT)),
          ),
          state_payload: Schema.NullOr(
            Schema.String.pipe(Schema.maxLength(MAX_EDIT_EVENT_TEXT)),
          ),
        }),
        rawHistory,
        "corrupt_state",
        "Invalid persisted task receipt history",
      )
      const operation = batch.operations[history.operation_index]
      const task = changesById.get(history.task_id)
      if (
        operation === undefined ||
        operation.op !== history.kind ||
        task === undefined ||
        history.persisted_task_id !== task.id ||
        recordedOperations.has(history.operation_index)
      )
        return yield* fail(
          "corrupt_state",
          "Task receipt identities disagree with persisted history",
        )

      const target: TaskReference =
        operation.op === "add"
          ? {
              issue: operation.issue,
              task: { kind: "added", key: operation.key },
            }
          : operation.target
      const identity = target.task
      const operationId =
        identity.kind === "existing"
          ? identity.id
          : created.find(
              item =>
                issueKey(item.issue) === issueKey(target.issue) &&
                item.key === identity.key,
            )?.id
      if (operationId !== task.id)
        return yield* fail(
          "corrupt_state",
          "Task receipt history disagrees with the requested target",
        )
      const prior = locations.get(task.id)
      const before =
        operation.op === "add"
          ? target.issue
          : identity.kind === "existing"
            ? (prior ?? target.issue)
            : prior
      if (
        before === undefined ||
        (operation.op === "add" && prior !== undefined) ||
        (identity.kind === "existing" &&
          (createdIds.has(task.id) ||
            issueKey(target.issue) !== issueKey(before)))
      )
        return yield* fail(
          "corrupt_state",
          "Task receipt has inconsistent operation-local ownership",
        )
      const after = operation.op === "transfer" ? operation.toIssue : before
      if (planIds.get(issueKey(after)) !== history.plan_id)
        return yield* fail(
          "corrupt_state",
          "Task history belongs to another operation-local issue",
        )
      if (operation.op === "transfer") {
        const payloadJson = history.transfer_payload
        if (payloadJson === null)
          return yield* fail(
            "corrupt_state",
            "Transfer history has no bounded provenance payload",
          )
        const rawPayload: unknown = yield* io(
          "Could not decode transfer provenance",
          () => JSON.parse(payloadJson),
        ).pipe(
          Effect.catchAll(() =>
            fail("corrupt_state", "Invalid transfer history JSON"),
          ),
        )
        const payload = yield* decode(
          TransferEventSchema,
          rawPayload,
          "corrupt_state",
          "Invalid transfer history",
        )
        const splitFrom = yield* storedIssue(payload.splitFrom)
        const destination = yield* storedIssue(payload.issue)
        if (
          payload.id !== task.id ||
          payload.operationIndex !== history.operation_index ||
          issueKey(splitFrom) !== issueKey(before) ||
          issueKey(destination) !== issueKey(after) ||
          issueKey(before) === issueKey(after)
        )
          return yield* fail(
            "corrupt_state",
            "Transfer provenance disagrees with the requested ownership change",
          )
      }
      let eventFields: readonly ChangedField[]
      switch (operation.op) {
        case "add":
          eventFields = ["text", "status", "blocker", "dependsOn"]
          break
        case "status": {
          const payload = yield* decodeEventPayload(
            StatusEventSchema,
            history.state_payload,
          )
          const owner = yield* storedIssue(payload.issue)
          if (
            payload.id !== task.id ||
            payload.operationIndex !== history.operation_index ||
            issueKey(owner) !== issueKey(before) ||
            payload.before === payload.after ||
            payload.after !== operation.status
          )
            return yield* fail(
              "corrupt_state",
              "Status history is inconsistent with the requested change",
            )
          eventFields = ["status"]
          break
        }
        case "block": {
          const payload = yield* decodeEventPayload(
            BlockEventSchema,
            history.state_payload,
          )
          const owner = yield* storedIssue(payload.issue)
          if (
            payload.id !== task.id ||
            payload.operationIndex !== history.operation_index ||
            issueKey(owner) !== issueKey(before) ||
            payload.before === payload.after ||
            payload.after !== operation.reason
          )
            return yield* fail(
              "corrupt_state",
              "Blocker history is inconsistent with the requested change",
            )
          eventFields = ["blocker"]
          break
        }
        case "transfer":
          eventFields = ["issue"]
          break
        case "edit": {
          const payloadJson = history.edit_payload
          if (payloadJson === null)
            return yield* fail(
              "corrupt_state",
              "Edit history has no bounded change payload",
            )
          const rawPayload: unknown = yield* io(
            "Could not decode edit history",
            () => JSON.parse(payloadJson),
          ).pipe(
            Effect.catchAll(() =>
              fail("corrupt_state", "Invalid edit history JSON"),
            ),
          )
          const payload = yield* decode(
            EditEventSchema,
            rawPayload,
            "corrupt_state",
            "Invalid edit history",
          )
          const owner = yield* storedIssue(payload.issue)
          const fields = payload.changes.map(change => change.field)
          const requestedDependencies = new Set<TaskId>()
          if (operation.dependsOn !== undefined) {
            for (const reference of operation.dependsOn) {
              const dependency = reference.task
              const id =
                dependency.kind === "existing"
                  ? dependency.id
                  : created.find(
                      allocation =>
                        issueKey(allocation.issue) ===
                          issueKey(reference.issue) &&
                        allocation.key === dependency.key,
                    )?.id
              if (id === undefined || requestedDependencies.has(id))
                return yield* fail(
                  "corrupt_state",
                  "Edit history has an invalid requested dependency identity",
                )
              requestedDependencies.add(id)
            }
          }
          if (
            payload.id !== task.id ||
            payload.operationIndex !== history.operation_index ||
            issueKey(owner) !== issueKey(before) ||
            new Set(fields).size !== fields.length ||
            payload.changes.some(change => {
              if (change.field === "text")
                return (
                  operation.text === undefined ||
                  change.before === change.after ||
                  change.after !== operation.text
                )
              if (operation.dependsOn === undefined) return true
              const prior = new Set(change.before)
              const next = new Set(change.after)
              return (
                prior.size !== change.before.length ||
                next.size !== change.after.length ||
                next.size !== requestedDependencies.size ||
                change.after.some(id => !requestedDependencies.has(id)) ||
                (prior.size === next.size &&
                  change.before.every(id => next.has(id)))
              )
            })
          )
            return yield* fail(
              "corrupt_state",
              "Edit history fields disagree with the requested change",
            )
          eventFields = fields
          break
        }
      }
      const fields = recordedFields.get(task.id) ?? new Set<ChangedField>()
      for (const field of eventFields) fields.add(field)
      recordedFields.set(task.id, fields)
      locations.set(task.id, after)
      recordedIssues.add(issueKey(before))
      recordedIssues.add(issueKey(after))
      recordedTasks.add(task.id)
      recordedOperations.add(history.operation_index)
    }
    if (
      recordedTasks.size !== changed.length ||
      recordedIssues.size !== plans.length ||
      changed.some(task => {
        const location = locations.get(task.id)
        const fields = recordedFields.get(task.id)
        return (
          location === undefined ||
          issueKey(location) !== issueKey(task.issue) ||
          fields === undefined ||
          fields.size !== task.fields.length ||
          task.fields.some(field => !fields.has(field))
        )
      }) ||
      plans.some(plan => !recordedIssues.has(issueKey(plan.issue)))
    )
      return yield* fail(
        "corrupt_state",
        "Task receipt changes disagree with persisted history",
      )

    return Option.some(
      Object.freeze({
        kind: "saved",
        receipt: "committed",
        batchId: saved.batchId,
        issues: Object.freeze(
          plans.map(row =>
            Object.freeze({ issue: row.issue, revision: row.revision }),
          ),
        ),
        changed: Object.freeze(changed),
        created: Object.freeze(created),
        eventCount: saved.eventCount,
      }),
    )
  })

const loadTaskSnapshot = (
  database: DatabaseSync,
  batch: TaskMutationBatch,
): StoreEffect<{
  readonly snapshot: TaskSnapshot
  readonly additions: readonly TaskIdAllocation[]
}> =>
  Effect.gen(function* () {
    const issues: IssueCandidate[] = []
    for (const issue of batch.issues) {
      const current = yield* findPlan(database, issue)
      if (Option.isSome(current))
        issues.push(
          Object.freeze({
            kind: "stored",
            state: Object.freeze({ issue, revision: current.value.revision }),
          }),
        )
      else
        issues.push(
          Object.freeze({
            kind: "new",
            state: Object.freeze({ issue, revision: 0 }),
          }),
        )
    }
    const references: TaskReference[] = []
    for (const operation of batch.operations) {
      if (operation.op !== "add") references.push(operation.target)
      if (operation.op === "add" || operation.op === "edit")
        references.push(
          ...(operation.dependsOn === undefined ? [] : operation.dependsOn),
        )
    }
    const ids = new Set(
      references.flatMap(reference =>
        reference.task.kind === "existing" ? [reference.task.id] : [],
      ),
    )
    if (ids.size > MAX_TRANSITION_NODES)
      return yield* fail(
        "capacity",
        "Too many task identities in one transaction",
      )
    const scopeSql = batch.issues
      .map(() => "(p.repository = ? AND p.issue_number = ?)")
      .join(" OR ")
    const scopeValues = batch.issues.flatMap(issue => [
      issue.repository,
      issue.number,
    ])
    const taskStatement = yield* io("Could not prepare task snapshot", () =>
      database.prepare(
        `SELECT t.id, t.text, t.status, t.blocker, p.repository, p.issue_number FROM issue_plan_tasks t JOIN issue_plans p ON p.id = t.plan_id WHERE t.id = ? AND (${scopeSql})`,
      ),
    )
    const rowSchema = Schema.Struct({
      id: TaskIdSchema,
      text: TextSchema,
      status: StatusSchema,
      blocker: Schema.NullOr(TextSchema),
      repository: Schema.String,
      issue_number: Schema.Number,
    })
    const tasks = new Map<TaskId, Omit<CurrentTask, "dependsOn">>()
    let textSize = 0
    for (const id of ids) {
      const raw = yield* io("Could not load current task", () =>
        taskStatement.get(id, ...scopeValues),
      )
      if (raw === undefined) continue
      const row = yield* decode(
        rowSchema,
        raw,
        "corrupt_state",
        "Invalid current task row",
      )
      const issue = yield* storedIssue({
        repository: row.repository,
        number: row.issue_number,
      })
      textSize +=
        row.text.length + (row.blocker === null ? 0 : row.blocker.length)
      if (textSize > MAX_TRANSITION_TEXT)
        return yield* fail(
          "capacity",
          "Current task text exceeds the transaction budget",
        )
      tasks.set(
        row.id,
        Object.freeze({
          id: row.id,
          text: row.text,
          status: row.status,
          blocker: row.blocker,
          issue,
        }),
      )
    }
    const queue = [...tasks.keys()]
    const seen = new Set(queue)
    const edges = new Map<TaskId, readonly TaskId[]>()
    const dependencies = yield* io(
      "Could not prepare dependency snapshot",
      () =>
        database.prepare(
          "SELECT depends_on_id FROM issue_plan_dependencies WHERE task_id = ? ORDER BY depends_on_id LIMIT ?",
        ),
    )
    const exists = yield* io(
      "Could not prepare dependency identity check",
      () => database.prepare("SELECT id FROM issue_plan_tasks WHERE id = ?"),
    )
    let edgeCount = 0
    for (let position = 0; position < queue.length; position += 1) {
      const id = queue[position]
      if (id === undefined)
        return yield* fail(
          "corrupt_state",
          "Invalid dependency snapshot position",
        )
      const raw = yield* io("Could not load dependencies", () =>
        dependencies.all(id, MAX_TASK_DEPENDENCIES + 1),
      )
      if (raw.length > MAX_TASK_DEPENDENCIES)
        return yield* fail("capacity", "A task has too many dependencies")
      const rows = yield* decode(
        Schema.Array(Schema.Struct({ depends_on_id: TaskIdSchema })),
        raw,
        "corrupt_state",
        "Invalid dependency row",
      )
      edgeCount += rows.length
      if (edgeCount > MAX_TRANSITION_EDGES)
        return yield* fail(
          "capacity",
          "Task dependency closure has too many edges",
        )
      const targets = Object.freeze(rows.map(row => row.depends_on_id))
      edges.set(id, targets)
      for (const target of targets)
        if (!seen.has(target)) {
          if (seen.size >= MAX_TRANSITION_NODES)
            return yield* fail(
              "capacity",
              "Task dependency closure has too many nodes",
            )
          const found = yield* io("Could not verify dependency target", () =>
            exists.get(target),
          )
          if (found === undefined)
            return yield* fail(
              "corrupt_state",
              "A persisted dependency target is missing",
            )
          seen.add(target)
          queue.push(target)
        }
      if (position % 128 === 127) yield* Effect.yieldNow()
    }
    const currentTasks: CurrentTask[] = []
    const external: DependencyNode[] = []
    for (const id of queue) {
      const dependsOn = edges.get(id)
      if (dependsOn === undefined)
        return yield* fail("corrupt_state", "Incomplete dependency projection")
      const task = tasks.get(id)
      if (task === undefined) external.push(Object.freeze({ id, dependsOn }))
      else currentTasks.push(Object.freeze({ ...task, dependsOn }))
    }
    const additions: TaskIdAllocation[] = []
    for (const operation of batch.operations)
      if (operation.op === "add") {
        const id = yield* decode(
          TaskIdSchema,
          yield* io("Could not generate task identity", randomUUID),
          "io",
          "Invalid generated task identity",
        )
        additions.push(
          Object.freeze({ issue: operation.issue, key: operation.key, id }),
        )
      }
    return {
      snapshot: { issues, tasks: currentTasks, external },
      additions: Object.freeze(additions),
    }
  })

const persistTaskChanges = (
  database: DatabaseSync,
  batch: TaskMutationBatch,
  context: TaskApplyContext,
  fingerprint: string,
  prepared: PreparedTaskChanges,
  additions: readonly TaskIdAllocation[],
): StoreEffect<TaskApplyResult> =>
  Effect.gen(function* () {
    const batchId = yield* decode(
      MutationBatchIdSchema,
      yield* io("Could not generate task batch identity", randomUUID),
      "io",
      "Invalid generated task batch identity",
    )
    const plans: StoredIssueRow[] = []
    for (const candidate of prepared.issues) {
      const { issue, revision } = candidate.state
      const current = yield* findPlan(database, issue)
      if (
        (candidate.kind === "new" && Option.isSome(current)) ||
        (candidate.kind === "stored" &&
          (Option.isNone(current) || current.value.revision + 1 !== revision))
      )
        return yield* fail(
          "corrupt_state",
          "Issue task revision changed after preparation",
        )
      const id = Option.isSome(current)
        ? current.value.id
        : yield* decode(
            StorageIssueIdSchema,
            yield* io("Could not allocate issue storage row", randomUUID),
            "io",
            "Invalid issue storage row identity",
          )
      plans.push(Object.freeze({ id, issue, revision }))
    }
    const result: TaskApplyResult = Object.freeze({
      kind: "saved",
      receipt: "committed",
      batchId,
      issues: Object.freeze(prepared.issues.map(candidate => candidate.state)),
      changed: prepared.changed,
      created: additions,
      eventCount: prepared.events.length,
    })
    // Historical receipt keys remain private; public ownership is issue-qualified.
    const resultJson = yield* encodedJson({
      kind: result.kind,
      receipt: result.receipt,
      batchId,
      plans,
      changed: result.changed,
      created: result.created,
      eventCount: result.eventCount,
    })
    if (resultJson.length > 1_048_576)
      return yield* fail("capacity", "Task result exceeds its receipt budget")
    const scopeJson = yield* encodedJson(batch.issues)
    const receiptWrite = yield* io("Could not save task request receipt", () =>
      database
        .prepare(
          "INSERT INTO issue_plan_batches (id, actor_id, request_id, fingerprint, scope_json, recorded_at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          batchId,
          context.actorId,
          context.requestId,
          fingerprint,
          scopeJson,
          context.now,
          resultJson,
        ),
    )
    if (receiptWrite.changes !== 1)
      return yield* fail(
        "corrupt_state",
        "Task request receipt was not saved exactly once",
      )

    const planIds = new Map<string, StorageIssueId>()
    for (const candidate of prepared.issues) {
      const plan = plans.find(
        row => issueKey(row.issue) === issueKey(candidate.state.issue),
      )
      if (plan === undefined)
        return yield* fail("corrupt_state", "Changed issue has no storage row")
      planIds.set(issueKey(plan.issue), plan.id)
      const updated = yield* io(
        "Could not save changed issue task state",
        () =>
          candidate.kind === "new"
            ? database
                .prepare(
                  "INSERT INTO issue_plans (id, repository, issue_number, revision) VALUES (?, ?, ?, ?)",
                )
                .run(
                  plan.id,
                  plan.issue.repository,
                  plan.issue.number,
                  plan.revision,
                )
            : database
                .prepare("UPDATE issue_plans SET revision = ? WHERE id = ?")
                .run(plan.revision, plan.id),
      )
      if (updated.changes !== 1)
        return yield* fail(
          "corrupt_state",
          "Changed issue task state was not saved exactly once",
        )
    }
    const newIds = new Set(additions.map(task => task.id))
    const originalOwners = new Map<TaskId, IssueReference>()
    for (const event of prepared.events)
      if (event.op === "transfer" && !originalOwners.has(event.id))
        originalOwners.set(event.id, event.splitFrom)
    for (const task of prepared.tasks) {
      const planId = planIds.get(issueKey(task.issue))
      const originalIssue = originalOwners.get(task.id) ?? task.issue
      const originalPlanId = planIds.get(issueKey(originalIssue))
      if (planId === undefined || originalPlanId === undefined)
        return yield* fail(
          "corrupt_state",
          "Changed task has no changed issue state",
        )
      const updated = yield* io("Could not save changed task", () =>
        newIds.has(task.id)
          ? database
              .prepare(
                "INSERT INTO issue_plan_tasks (id, plan_id, text, status, blocker) VALUES (?, ?, ?, ?, ?)",
              )
              .run(task.id, planId, task.text, task.status, task.blocker)
          : database
              .prepare(
                "UPDATE issue_plan_tasks SET plan_id = ?, text = ?, status = ?, blocker = ? WHERE id = ? AND plan_id = ?",
              )
              .run(
                planId,
                task.text,
                task.status,
                task.blocker,
                task.id,
                originalPlanId,
              ),
      )
      if (updated.changes !== 1)
        return yield* fail(
          "corrupt_state",
          "Changed task was not saved exactly once",
        )
    }
    for (const task of prepared.tasks) {
      yield* io("Could not replace task dependency edges", () =>
        database
          .prepare("DELETE FROM issue_plan_dependencies WHERE task_id = ?")
          .run(task.id),
      )
      for (const target of task.dependsOn) {
        const inserted = yield* io("Could not save task dependency edge", () =>
          database
            .prepare(
              "INSERT INTO issue_plan_dependencies (task_id, depends_on_id) VALUES (?, ?)",
            )
            .run(task.id, target),
        )
        if (inserted.changes !== 1)
          return yield* fail(
            "corrupt_state",
            "Task dependency edge was not saved exactly once",
          )
      }
    }
    for (const event of prepared.events) {
      const identity = event.op === "add" ? event.task : event
      const planId = planIds.get(issueKey(identity.issue))
      if (planId === undefined)
        return yield* fail(
          "corrupt_state",
          "Task history event has no changed issue state",
        )
      const payload = yield* encodedJson(event)
      const inserted = yield* io("Could not append task history", () =>
        database
          .prepare(
            "INSERT INTO issue_plan_history (batch_id, plan_id, task_id, operation_index, kind, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            batchId,
            planId,
            identity.id,
            event.operationIndex,
            event.op,
            context.now,
            payload,
          ),
      )
      if (inserted.changes !== 1)
        return yield* fail(
          "corrupt_state",
          "Task history event was not saved exactly once",
        )
    }

    for (const event of prepared.events) {
      const identity = event.op === "add" ? event.task : event
      const planId = planIds.get(issueKey(identity.issue))
      if (planId === undefined)
        return yield* fail(
          "corrupt_state",
          "Saved task history lost its changed issue state",
        )
      const payload = yield* encodedJson(event)
      const exact = yield* io("Could not verify saved task history", () =>
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM issue_plan_history WHERE batch_id = ? AND operation_index = ? AND plan_id = ? AND task_id = ? AND kind = ? AND recorded_at = ? AND payload_json = ?",
          )
          .get(
            batchId,
            event.operationIndex,
            planId,
            identity.id,
            event.op,
            context.now,
            payload,
          ),
      )
      yield* decode(
        Schema.Struct({ count: Schema.Literal(1) }),
        exact,
        "corrupt_state",
        "Saved task history disagrees with the prepared event",
      )
    }

    const stored = yield* readReceipt(
      database,
      batch,
      context,
      fingerprint,
    ).pipe(
      Effect.catchTag("TaskRequestConflictError", () =>
        fail(
          "corrupt_state",
          "Saved task request intent changed during persistence",
        ),
      ),
    )
    if (Option.isNone(stored))
      return yield* fail(
        "corrupt_state",
        "Saved task request receipt disappeared",
      )

    for (const plan of plans) {
      const persisted = yield* findPlan(database, plan.issue)
      if (
        Option.isNone(persisted) ||
        persisted.value.id !== plan.id ||
        persisted.value.revision !== plan.revision
      )
        return yield* fail(
          "corrupt_state",
          "Saved issue task state disagrees with the prepared change",
        )
    }

    for (const task of prepared.tasks) {
      const row = yield* io("Could not verify saved task", () =>
        database
          .prepare(
            "SELECT id, plan_id, text, status, blocker FROM issue_plan_tasks WHERE id = ?",
          )
          .get(task.id),
      )
      const persisted = yield* decode(
        Schema.extend(
          TaskRowSchema,
          Schema.Struct({ plan_id: StorageIssueIdSchema }),
        ),
        row,
        "corrupt_state",
        "Invalid saved task projection",
      )
      if (
        persisted.plan_id !== planIds.get(issueKey(task.issue)) ||
        persisted.text !== task.text ||
        persisted.status !== task.status ||
        persisted.blocker !== task.blocker
      )
        return yield* fail(
          "corrupt_state",
          "Saved task projection disagrees with the prepared change",
        )

      const rawEdges = yield* io(
        "Could not verify saved task dependencies",
        () =>
          database
            .prepare(
              "SELECT depends_on_id FROM issue_plan_dependencies WHERE task_id = ? ORDER BY depends_on_id LIMIT ?",
            )
            .all(task.id, MAX_TASK_DEPENDENCIES + 1),
      )
      const edges = yield* decode(
        Schema.Array(Schema.Struct({ depends_on_id: TaskIdSchema })),
        rawEdges,
        "corrupt_state",
        "Invalid saved task dependency projection",
      )
      if (
        edges.length !== task.dependsOn.length ||
        edges.some(
          (edge, index) => edge.depends_on_id !== task.dependsOn[index],
        )
      )
        return yield* fail(
          "corrupt_state",
          "Saved task dependencies disagree with the prepared change",
        )
    }

    return result
  })

interface AppliedTaskRequest {
  readonly batch: TaskMutationBatch
  readonly context: TaskApplyContext
  readonly fingerprint: string
  readonly result: TaskApplyResult
}

const readCommittedRequest = (
  options: ValidatedPlanStoreOptions,
  request: AppliedTaskRequest,
): StoreEffect<TaskApplyResult> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      yield* secureFile(options.databasePath, "existing")
      const database = yield* io(
        "Could not open task recovery reader",
        () => new DatabaseSync(options.databasePath, { readOnly: true }),
      )
      const observed = yield* Effect.exit(
        Effect.gen(function* () {
          yield* io("Could not configure task recovery reader", () =>
            database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs};`),
          )
          return yield* transaction(
            database,
            "read",
            Effect.gen(function* () {
              yield* checkVersion(database)
              const receipt = yield* readReceipt(
                database,
                request.batch,
                request.context,
                request.fingerprint,
              ).pipe(
                Effect.catchTag("TaskRequestConflictError", () =>
                  fail(
                    "corrupt_state",
                    "Recovery receipt has different task intent",
                  ),
                ),
              )
              if (Option.isNone(receipt))
                return yield* fail(
                  "corrupt_state",
                  "No durable task receipt confirms this commit",
                )

              const expected = yield* encodedJson({
                ...request.result,
                receipt: "committed",
              })
              const actual = yield* encodedJson(receipt.value)
              if (actual !== expected)
                return yield* fail(
                  "corrupt_state",
                  "Recovery receipt differs from the original task result",
                )

              return receipt.value
            }),
          )
        }),
      )
      const closed = yield* Effect.exit(
        io("Could not close task recovery reader", () => database.close()),
      )
      if (Exit.isFailure(observed))
        return yield* Effect.failCause(
          Exit.isFailure(closed)
            ? Cause.sequential(observed.cause, closed.cause)
            : observed.cause,
        )
      if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause)

      return observed.value
    }),
  )

const recoverTaskCommit = (
  options: ValidatedPlanStoreOptions,
  request: AppliedTaskRequest,
  cause: Cause.Cause<TaskStoreError>,
): Effect.Effect<AppliedTaskRequest, TaskCommitUnknownError> =>
  Effect.gen(function* () {
    const observed = yield* Effect.exit(readCommittedRequest(options, request))
    if (Exit.isFailure(observed))
      return yield* Effect.fail(
        new TaskCommitUnknownError({
          code: "unknown_completion",
          batchId: request.result.batchId,
          requestId: request.context.requestId,
          message:
            "Task commit completion could not be confirmed; do not reapply with a new request identity",
          cause: Cause.sequential(cause, observed.cause),
        }),
      )

    return Object.freeze({
      ...request,
      result: Object.freeze({
        ...observed.value,
        receipt: "recovered" as const,
      }),
    })
  })

const makeStore = (
  database: DatabaseSync,
  options: ValidatedPlanStoreOptions,
): SqliteTaskStore => {
  const gate = Effect.unsafeMakeSemaphore(1)
  let state: ConnectionState = "open"
  const use = <A, E, F = never>(
    mode: "read" | "write",
    operation: Effect.Effect<A, E>,
    recoverCommit?: (
      value: A,
      cause: Cause.Cause<TaskStoreError>,
    ) => Effect.Effect<A, F>,
  ): Effect.Effect<A, E | F | TaskStoreError> =>
    gate.withPermits(1)(
      Effect.suspend(() => {
        if (state === "closed") return fail("closed", "Task store is closed")
        if (state === "unusable")
          return fail(
            "io",
            "Task-store connection is unusable after a database failure",
          )
        return transaction(
          database,
          mode,
          checkVersion(database).pipe(Effect.andThen(operation)),
          () => {
            state = "unusable"
          },
          recoverCommit,
        )
      }),
    )
  return {
    apply: (input, suppliedContext) =>
      use(
        "write",
        Effect.gen(function* () {
          yield* options.taskTransactionBeginSignal === undefined
            ? Effect.void
            : options.taskTransactionBeginSignal
          const decoded = decodeTaskMutationBatch(input)
          if (Either.isLeft(decoded)) return yield* Effect.fail(decoded.left)
          const batch = decoded.right
          const context = yield* decode(
            ContextSchema,
            suppliedContext,
            "invalid_input",
            "Invalid trusted task request context",
          )
          const fingerprint = yield* io(
            "Could not fingerprint task intent",
            () =>
              createHash("sha256")
                .update(
                  JSON.stringify({ batch, cancellation: context.cancellation }),
                )
                .digest("hex"),
          )
          const previous = yield* readReceipt(
            database,
            batch,
            context,
            fingerprint,
          )
          if (Option.isSome(previous))
            return Object.freeze({
              batch,
              context,
              fingerprint,
              result: Object.freeze({
                ...previous.value,
                receipt: "replayed" as const,
              }),
            })
          const loaded = yield* loadTaskSnapshot(database, batch)
          const prepared = prepareTaskChanges(batch, loaded.snapshot, {
            cancellation: context.cancellation,
            additions: loaded.additions,
          })
          if (Either.isLeft(prepared)) return yield* Effect.fail(prepared.left)
          const result = yield* persistTaskChanges(
            database,
            batch,
            context,
            fingerprint,
            prepared.right,
            loaded.additions,
          )
          return Object.freeze({ batch, context, fingerprint, result })
        }),
        (request, cause) => recoverTaskCommit(options, request, cause),
      ).pipe(Effect.map(request => request.result)),
    readTasks: (target, input) =>
      use(
        "read",
        Effect.gen(function* () {
          const issue = yield* checkedIssue(target, "invalid_input")
          const page = yield* decode(
            PageSchema,
            input,
            "invalid_input",
            "Task pages require a limit from 1 to 100 and an optional task cursor",
          )
          const stored = yield* findPlan(database, issue)
          if (Option.isNone(stored)) {
            if (page.after !== undefined)
              return yield* fail(
                "invalid_input",
                "Cursor does not belong to the requested issue",
              )
            return Option.none()
          }
          const plan = stored.value
          const after = page.after
          if (after !== undefined) {
            const cursor = yield* io("Could not validate task cursor", () =>
              database
                .prepare(
                  "SELECT id FROM issue_plan_tasks WHERE plan_id = ? AND id = ?",
                )
                .get(plan.id, after),
            )
            if (cursor === undefined)
              return yield* fail(
                "invalid_input",
                "Cursor does not belong to the requested issue",
              )
          }
          const rows = yield* io("Could not read issue tasks", () =>
            page.after === undefined
              ? database
                  .prepare(
                    "SELECT id, text, status, blocker FROM issue_plan_tasks WHERE plan_id = ? ORDER BY id LIMIT ?",
                  )
                  .all(plan.id, page.limit + 1)
              : database
                  .prepare(
                    "SELECT id, text, status, blocker FROM issue_plan_tasks WHERE plan_id = ? AND id > ? ORDER BY id LIMIT ?",
                  )
                  .all(plan.id, page.after, page.limit + 1),
          )
          const tasks = yield* decode(
            Schema.Array(TaskRowSchema),
            rows,
            "corrupt_state",
            "Invalid persisted task",
          )
          const visible = Object.freeze(
            tasks.slice(0, page.limit).map(task => Object.freeze(task)),
          )
          const last = visible.at(-1)
          if (tasks.length > page.limit && last === undefined)
            return yield* fail("corrupt_state", "Invalid task page boundary")
          return Option.some(
            Object.freeze({
              issue: plan.issue,
              revision: plan.revision,
              tasks: visible,
              next:
                tasks.length > page.limit && last !== undefined
                  ? last.id
                  : null,
            }),
          )
        }),
      ),
    close: () =>
      gate.withPermits(1)(
        Effect.suspend(() => {
          if (state === "closed") return Effect.void
          state = "unusable"
          return io("Could not close task database", () =>
            database.close(),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                state = "closed"
              }),
            ),
          )
        }),
      ),
  }
}

export const openSqliteTaskStore = (
  options: SqliteTaskStoreOptions,
): StoreEffect<SqliteTaskStore> =>
  Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      const timeout =
        options.busyTimeoutMs === undefined ? 2_000 : options.busyTimeoutMs
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_000)
        return yield* fail(
          "invalid_input",
          "Busy timeout must be an integer from 0 to 2000 milliseconds",
        )
      const captured = Object.freeze({
        databasePath: options.databasePath,
        busyTimeoutMs: timeout,
        taskTransactionBeginSignal: options.taskTransactionBeginSignal,
      })
      yield* secureFile(captured.databasePath)
      const database = yield* io(
        "Could not open task database",
        () => new DatabaseSync(captured.databasePath),
      )
      const initialized = yield* Effect.exit(
        restore(initialize(database, timeout)),
      )
      if (Exit.isFailure(initialized)) {
        const closed = yield* Effect.exit(
          io("Could not close invalid task database", () => database.close()),
        )
        return yield* Effect.failCause(
          Exit.isFailure(closed)
            ? Cause.sequential(initialized.cause, closed.cause)
            : initialized.cause,
        )
      }
      return makeStore(database, captured)
    }),
  )
