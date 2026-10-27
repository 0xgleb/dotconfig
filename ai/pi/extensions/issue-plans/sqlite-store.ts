import { randomUUID } from "node:crypto"
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Cause, Data, Effect, Either, Exit, Option, Schema } from "effect"
import { decodeIssueReference, type IssueReference } from "./identity.ts"

const PlanIdSchema = Schema.UUID.pipe(
  Schema.brand("IssuePlanId"),
  Schema.filter(value => value === value.toLowerCase()),
)
const TaskIdSchema = Schema.UUID.pipe(
  Schema.brand("IssueTaskId"),
  Schema.filter(value => value === value.toLowerCase()),
)
const RevisionSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const TextSchema = Schema.String.pipe(
  Schema.maxLength(131_072),
  Schema.filter(value => value.trim().length > 0),
  Schema.filter(
    value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
  ),
)
const StatusSchema = Schema.Literal("todo", "doing", "done", "cancelled")
const PageSchema = Schema.Struct({
  limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
  after: Schema.optional(TaskIdSchema),
})
const PlanRowSchema = Schema.Struct({
  id: PlanIdSchema,
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

export type PlanId = typeof PlanIdSchema.Type
export type TaskId = typeof TaskIdSchema.Type
export type TaskStatus = typeof StatusSchema.Type

export interface IssuePlan {
  readonly id: PlanId
  readonly issue: IssueReference
  readonly revision: number
}
export interface PlanTask {
  readonly id: TaskId
  readonly text: string
  readonly status: TaskStatus
  readonly blocker: string | null
}
export interface PlanPage {
  readonly plan: IssuePlan
  readonly tasks: readonly PlanTask[]
  readonly next: TaskId | null
}
export interface PlanPageInput {
  readonly limit: number
  readonly after?: TaskId
}

export class PlanStoreError extends Data.TaggedError("PlanStoreError")<{
  readonly code:
    | "invalid_input"
    | "invalid_path"
    | "unsupported_schema"
    | "corrupt_state"
    | "busy"
    | "closed"
    | "io"
  readonly message: string
}> {}

export interface SqlitePlanStore {
  readonly ensurePlan: (issue: IssueReference) => StoreEffect<IssuePlan>
  readonly readPlan: (
    issue: IssueReference,
    page: PlanPageInput,
  ) => StoreEffect<Option.Option<PlanPage>>
  readonly close: () => StoreEffect<void>
}
export interface SqlitePlanStoreOptions {
  readonly databasePath: string
  readonly busyTimeoutMs?: number
}

type StoreEffect<A> = Effect.Effect<A, PlanStoreError>
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

const normalizedDeclaration = (sql: string): string =>
  sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "")

const fail = (
  code: PlanStoreError["code"],
  message: string,
): StoreEffect<never> => Effect.fail(new PlanStoreError({ code, message }))

const io = <A>(message: string, operation: () => A): StoreEffect<A> =>
  Effect.try({
    try: operation,
    catch: error =>
      new PlanStoreError({
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
  code: PlanStoreError["code"],
  message: string,
): StoreEffect<A> =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new PlanStoreError({ code, message })),
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

const planFrom = (value: unknown): StoreEffect<IssuePlan> =>
  Effect.gen(function* () {
    const row = yield* decode(
      PlanRowSchema,
      value,
      "corrupt_state",
      "Invalid persisted issue plan",
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

const transaction = <A>(
  database: DatabaseSync,
  mode: "read" | "write",
  work: StoreEffect<A>,
  poison: () => void = () => {},
): StoreEffect<A> =>
  Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      yield* retryBusy(
        io("Could not begin plan transaction", () =>
          database.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN"),
        ),
      )
      const result = yield* Effect.exit(
        restore(
          work.pipe(
            Effect.flatMap(value =>
              io("Could not commit plan transaction", () =>
                database.exec("COMMIT"),
              ).pipe(Effect.as(value)),
            ),
          ),
        ),
      )
      if (Exit.isSuccess(result)) return result.value
      const rollback = yield* Effect.exit(
        io("Could not roll back plan transaction", () =>
          database.exec("ROLLBACK"),
        ),
      )
      if (Exit.isFailure(rollback)) {
        poison()
        return yield* Effect.failCause(
          Cause.sequential(result.cause, rollback.cause),
        )
      }
      return yield* Effect.failCause(result.cause)
    }),
  )

class FileExists extends Data.TaggedError("FileExists") {}

const secureFile = (path: string): StoreEffect<void> =>
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
    const descriptor = yield* Effect.try({
      try: () => openSync(path, "wx", 0o600),
      catch: error =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
          ? new FileExists()
          : new PlanStoreError({
              code: "io",
              message: "Could not create private database file",
            }),
    }).pipe(Effect.catchTag("FileExists", () => Effect.succeed(undefined)))
    if (descriptor !== undefined)
      yield* io("Could not close new database file", () =>
        closeSync(descriptor),
      )
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
): StoreEffect<readonly string[]> =>
  Effect.gen(function* () {
    const rows = yield* io("Could not inspect plan schema", () =>
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name COLLATE NOCASE IN ('issue_plan_schema', 'issue_plans', 'issue_plan_tasks', 'issue_plan_tasks_by_plan')",
        )
        .all(),
    )
    const decoded = yield* decode(
      Schema.Array(Schema.Struct({ name: Schema.String })),
      rows,
      "unsupported_schema",
      "Invalid plan schema metadata",
    )
    return decoded.map(row => row.name)
  })

const checkVersion = (database: DatabaseSync): StoreEffect<void> =>
  Effect.gen(function* () {
    const raw = yield* io("Could not read plan schema version", () =>
      database
        .prepare("SELECT id, version FROM issue_plan_schema LIMIT 2")
        .all(),
    )
    const rows = yield* decode(
      Schema.Array(
        Schema.Struct({ id: Schema.Literal(1), version: Schema.Number }),
      ),
      raw,
      "unsupported_schema",
      "Invalid plan schema version",
    )
    if (rows.length !== 1 || rows[0]?.version !== 1)
      return yield* fail(
        "unsupported_schema",
        "Unsupported issue-plan schema version",
      )
  })

const checkNamespace = (
  database: DatabaseSync,
  tables: readonly string[],
): StoreEffect<void> =>
  Effect.gen(function* () {
    if (tables.length !== schemaDeclarations.length)
      return yield* fail(
        "unsupported_schema",
        "Incomplete or conflicting issue-plan schema",
      )
    yield* checkVersion(database)
    const raw = yield* io("Could not validate plan schema declarations", () =>
      database
        .prepare(
          "SELECT name, type, sql FROM sqlite_schema WHERE name IN ('issue_plan_schema', 'issue_plans', 'issue_plan_tasks', 'issue_plan_tasks_by_plan')",
        )
        .all(),
    )
    const declarations = yield* decode(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          type: Schema.Literal("table", "index"),
          sql: Schema.String,
        }),
      ),
      raw,
      "unsupported_schema",
      "Invalid issue-plan schema declarations",
    )
    if (declarations.length !== schemaDeclarations.length)
      return yield* fail(
        "unsupported_schema",
        "Incomplete issue-plan schema declarations",
      )
    for (const actual of declarations) {
      const expected = schemaDeclarations.find(
        entry => entry.name === actual.name,
      )
      if (
        expected === undefined ||
        actual.type !== expected.type ||
        normalizedDeclaration(actual.sql) !==
          normalizedDeclaration(expected.sql)
      )
        return yield* fail(
          "unsupported_schema",
          "Incompatible issue-plan schema constraints",
        )
    }
  })

const migrate = (database: DatabaseSync): StoreEffect<void> =>
  Effect.gen(function* () {
    const tables = yield* namespaceObjects(database)
    if (tables.includes("issue_plan_schema"))
      return yield* checkNamespace(database, tables)
    yield* transaction(
      database,
      "write",
      Effect.gen(function* () {
        const current = yield* namespaceObjects(database)
        if (current.includes("issue_plan_schema"))
          return yield* checkNamespace(database, current)
        if (current.length !== 0)
          return yield* fail(
            "unsupported_schema",
            "Unversioned issue-plan tables already exist",
          )
        yield* io("Could not create issue-plan schema", () =>
          database.exec(
            `${schemaDeclarations.map(entry => entry.sql).join(";\n")};\nINSERT INTO issue_plan_schema (id, version) VALUES (1, 1);`,
          ),
        )
      }),
    )
  })

const initialize = (
  database: DatabaseSync,
  timeout: number,
): StoreEffect<void> =>
  Effect.gen(function* () {
    yield* io("Could not configure plan connection", () =>
      database.exec(
        `PRAGMA busy_timeout = ${timeout}; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`,
      ),
    )
    const existing = yield* namespaceObjects(database)
    if (existing.length !== 0) yield* checkNamespace(database, existing)
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
    yield* migrate(database)
  })

const makeStore = (database: DatabaseSync): SqlitePlanStore => {
  const gate = Effect.unsafeMakeSemaphore(1)
  let state: ConnectionState = "open"
  const use = <A>(
    mode: "read" | "write",
    operation: StoreEffect<A>,
  ): StoreEffect<A> =>
    gate.withPermits(1)(
      Effect.suspend(() => {
        if (state === "closed") return fail("closed", "Plan store is closed")
        if (state === "unusable")
          return fail(
            "io",
            "Plan connection is unusable after a database failure",
          )
        return transaction(
          database,
          mode,
          checkVersion(database).pipe(Effect.andThen(operation)),
          () => {
            state = "unusable"
          },
        )
      }),
    )
  return {
    ensurePlan: target =>
      use(
        "write",
        Effect.gen(function* () {
          const issue = yield* checkedIssue(target, "invalid_input")
          const existing = yield* io("Could not read issue plan", () =>
            database
              .prepare(
                "SELECT id, repository, issue_number, revision FROM issue_plans WHERE repository = ? AND issue_number = ?",
              )
              .get(issue.repository, issue.number),
          )
          if (existing !== undefined) return yield* planFrom(existing)
          const generated = yield* io(
            "Could not generate plan identity",
            randomUUID,
          )
          const id = yield* decode(
            PlanIdSchema,
            generated,
            "io",
            "Invalid generated plan identity",
          )
          yield* io("Could not save issue plan", () =>
            database
              .prepare(
                "INSERT INTO issue_plans (id, repository, issue_number, revision) VALUES (?, ?, ?, 0)",
              )
              .run(id, issue.repository, issue.number),
          )
          return Object.freeze({ id, issue, revision: 0 })
        }),
      ),
    readPlan: (target, input) =>
      use(
        "read",
        Effect.gen(function* () {
          const issue = yield* checkedIssue(target, "invalid_input")
          const page = yield* decode(
            PageSchema,
            input,
            "invalid_input",
            "Plan pages require a limit from 1 to 100 and an optional task cursor",
          )
          const raw = yield* io("Could not read issue plan", () =>
            database
              .prepare(
                "SELECT id, repository, issue_number, revision FROM issue_plans WHERE repository = ? AND issue_number = ?",
              )
              .get(issue.repository, issue.number),
          )
          if (raw === undefined) {
            if (page.after !== undefined)
              return yield* fail(
                "invalid_input",
                "Cursor does not belong to the requested plan",
              )
            return Option.none()
          }
          const plan = yield* planFrom(raw)
          const after = page.after
          if (after !== undefined) {
            const cursor = yield* io("Could not validate plan cursor", () =>
              database
                .prepare(
                  "SELECT id FROM issue_plan_tasks WHERE plan_id = ? AND id = ?",
                )
                .get(plan.id, after),
            )
            if (cursor === undefined)
              return yield* fail(
                "invalid_input",
                "Cursor does not belong to the requested plan",
              )
          }
          const rows = yield* io("Could not read plan tasks", () =>
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
            "Invalid persisted plan task",
          )
          const visible = Object.freeze(
            tasks.slice(0, page.limit).map(task => Object.freeze(task)),
          )
          const last = visible.at(-1)
          if (tasks.length > page.limit && last === undefined)
            return yield* fail("corrupt_state", "Invalid plan page boundary")
          return Option.some(
            Object.freeze({
              plan,
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
          return io("Could not close plan database", () =>
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

export const openSqlitePlanStore = (
  options: SqlitePlanStoreOptions,
): StoreEffect<SqlitePlanStore> =>
  Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      const timeout =
        options.busyTimeoutMs === undefined ? 2_000 : options.busyTimeoutMs
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_000)
        return yield* fail(
          "invalid_input",
          "Busy timeout must be an integer from 0 to 2000 milliseconds",
        )
      yield* secureFile(options.databasePath)
      const database = yield* io(
        "Could not open plan database",
        () => new DatabaseSync(options.databasePath),
      )
      const initialized = yield* Effect.exit(
        restore(initialize(database, timeout)),
      )
      if (Exit.isFailure(initialized)) {
        const closed = yield* Effect.exit(
          io("Could not close invalid plan database", () => database.close()),
        )
        return yield* Effect.failCause(
          Exit.isFailure(closed)
            ? Cause.sequential(initialized.cause, closed.cause)
            : initialized.cause,
        )
      }
      return makeStore(database)
    }),
  )
