import { Data, Either, Schema } from "effect"
import {
  decodeIssueReference,
  decodeIssueScope,
  issueKey,
  type IssueReference,
} from "./identity.ts"
import {
  StatusSchema,
  TaskIdSchema,
  TextSchema,
  type TaskId,
  type TaskStatus,
} from "./model.ts"

export const DraftKeySchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  Schema.brand("DraftTaskKey"),
)
export type DraftTaskKey = typeof DraftKeySchema.Type
export type TaskTarget =
  | { readonly kind: "existing"; readonly id: TaskId }
  | { readonly kind: "added"; readonly key: DraftTaskKey }
export interface TaskReference {
  readonly issue: IssueReference
  readonly task: TaskTarget
}
export type TaskMutation =
  | {
      readonly op: "add"
      readonly issue: IssueReference
      readonly key: DraftTaskKey
      readonly text: string
      readonly dependsOn: readonly TaskReference[]
    }
  | {
      readonly op: "edit"
      readonly target: TaskReference
      readonly text?: string
      readonly dependsOn?: readonly TaskReference[]
    }
  | {
      readonly op: "status"
      readonly target: TaskReference
      readonly status: TaskStatus
    }
  | {
      readonly op: "block"
      readonly target: TaskReference
      readonly reason: string | null
    }
export interface TaskMutationBatch {
  readonly issues: readonly IssueReference[]
  readonly operations: readonly TaskMutation[]
}

export const MAX_TASK_MUTATIONS = 1_000
export const MAX_TASK_DEPENDENCIES = 1_000
export const MAX_BATCH_REFERENCES = 10_000
export const MAX_BATCH_TEXT = 262_144

export class TaskMutationError extends Data.TaggedError("TaskMutationError")<{
  readonly code:
    "invalid_batch" | "invalid_operation" | "scope_mismatch" | "capacity"
  readonly message: string
}> {}

type Result<A> = Either.Either<A, TaskMutationError>
const invalid = (
  code: TaskMutationError["code"],
  message: string,
): Result<never> => Either.left(new TaskMutationError({ code, message }))
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const shape = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): value is Readonly<Record<string, unknown>> =>
  record(value) &&
  Reflect.ownKeys(value).every(
    key => typeof key === "string" && allowed.includes(key),
  ) &&
  required.every(key => Object.hasOwn(value, key))
const leaf = <A, I>(schema: Schema.Schema<A, I>, value: unknown): Result<A> =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(value).pipe(
    Either.mapLeft(
      () =>
        new TaskMutationError({
          code: "invalid_operation",
          message: "Malformed task operation value",
        }),
    ),
  )
const draftIdentity = (issue: IssueReference, key: DraftTaskKey): string =>
  `${issueKey(issue)}:${key}`
const referenceIdentity = (reference: TaskReference): string =>
  `${issueKey(reference.issue)}:${reference.task.kind}:${reference.task.kind === "existing" ? reference.task.id : reference.task.key}`
const freezeMutation = (operation: TaskMutation): TaskMutation =>
  Object.freeze(operation)

const scopedIssue = (
  raw: unknown,
  scope: ReadonlySet<string>,
): Result<IssueReference> =>
  Either.gen(function* () {
    const decoded = decodeIssueReference(raw)
    if (Either.isLeft(decoded))
      return yield* invalid(
        "invalid_operation",
        "Operation requires a qualified issue",
      )
    if (!scope.has(issueKey(decoded.right)))
      return yield* invalid(
        "scope_mismatch",
        "Every affected issue must be listed in the explicit scope",
      )
    return decoded.right
  })

const reference = (
  raw: unknown,
  scope: ReadonlySet<string>,
  additions: ReadonlySet<string>,
): Result<TaskReference> =>
  Either.gen(function* () {
    if (!shape(raw, ["issue", "task"], ["issue", "task"]))
      return yield* invalid(
        "invalid_operation",
        "Task reference requires only issue and task",
      )
    const issue = yield* scopedIssue(raw.issue, scope)
    if (!record(raw.task))
      return yield* invalid("invalid_operation", "Invalid task target")
    if (raw.task.kind === "existing") {
      if (!shape(raw.task, ["kind", "id"], ["kind", "id"]))
        return yield* invalid(
          "invalid_operation",
          "Existing task requires only kind and id",
        )
      const id = yield* leaf(TaskIdSchema, raw.task.id)
      return Object.freeze({
        issue,
        task: Object.freeze({ kind: "existing", id }),
      })
    }
    if (raw.task.kind === "added") {
      if (!shape(raw.task, ["kind", "key"], ["kind", "key"]))
        return yield* invalid(
          "invalid_operation",
          "Added task requires only kind and key",
        )
      const key = yield* leaf(DraftKeySchema, raw.task.key)
      if (!additions.has(draftIdentity(issue, key)))
        return yield* invalid(
          "invalid_operation",
          "Draft task key must refer to an earlier add in the same batch",
        )
      return Object.freeze({
        issue,
        task: Object.freeze({ kind: "added", key }),
      })
    }
    return yield* invalid("invalid_operation", "Unknown task target kind")
  })

const dependencies = (
  raw: unknown,
  scope: ReadonlySet<string>,
  additions: ReadonlySet<string>,
): Result<readonly TaskReference[]> =>
  Either.gen(function* () {
    if (!Array.isArray(raw))
      return yield* invalid(
        "invalid_operation",
        "Dependencies require an explicit array",
      )
    if (raw.length > MAX_TASK_DEPENDENCIES)
      return yield* invalid(
        "capacity",
        "Too many dependencies in one operation",
      )
    const decoded: TaskReference[] = []
    const identities = new Set<string>()
    for (const value of raw) {
      const target = yield* reference(value, scope, additions)
      const identity = referenceIdentity(target)
      if (identities.has(identity))
        return yield* invalid(
          "invalid_operation",
          "Dependencies must be distinct",
        )
      identities.add(identity)
      decoded.push(target)
    }
    return Object.freeze(decoded)
  })

const mutation = (
  raw: unknown,
  scope: ReadonlySet<string>,
  additions: ReadonlySet<string>,
): Result<TaskMutation> =>
  Either.gen(function* () {
    if (!record(raw))
      return yield* invalid(
        "invalid_operation",
        "An operation must be an object",
      )
    switch (raw.op) {
      case "add": {
        if (
          !shape(
            raw,
            ["op", "issue", "key", "text", "dependsOn"],
            ["op", "issue", "key", "text"],
          )
        )
          return yield* invalid("invalid_operation", "Invalid add fields")
        const issue = yield* scopedIssue(raw.issue, scope)
        const key = yield* leaf(DraftKeySchema, raw.key)
        if (additions.has(draftIdentity(issue, key)))
          return yield* invalid(
            "invalid_operation",
            "Draft task keys must be distinct within an issue",
          )
        const text = yield* leaf(TextSchema, raw.text)
        const dependsOn = Object.hasOwn(raw, "dependsOn")
          ? yield* dependencies(raw.dependsOn, scope, additions)
          : Object.freeze([])
        return freezeMutation({ op: "add", issue, key, text, dependsOn })
      }
      case "edit": {
        if (
          !shape(
            raw,
            ["op", "target", "text", "dependsOn"],
            ["op", "target"],
          ) ||
          (!Object.hasOwn(raw, "text") && !Object.hasOwn(raw, "dependsOn"))
        )
          return yield* invalid(
            "invalid_operation",
            "An edit requires text or dependencies",
          )
        const target = yield* reference(raw.target, scope, additions)
        const text = Object.hasOwn(raw, "text")
          ? yield* leaf(TextSchema, raw.text)
          : undefined
        const dependsOn = Object.hasOwn(raw, "dependsOn")
          ? yield* dependencies(raw.dependsOn, scope, additions)
          : undefined
        return freezeMutation({
          op: "edit",
          target,
          ...(text === undefined ? {} : { text }),
          ...(dependsOn === undefined ? {} : { dependsOn }),
        })
      }
      case "status": {
        if (!shape(raw, ["op", "target", "status"], ["op", "target", "status"]))
          return yield* invalid("invalid_operation", "Invalid status fields")
        const target = yield* reference(raw.target, scope, additions)
        const status = yield* leaf(StatusSchema, raw.status)
        return freezeMutation({ op: "status", target, status })
      }
      case "block": {
        if (!shape(raw, ["op", "target", "reason"], ["op", "target", "reason"]))
          return yield* invalid("invalid_operation", "Invalid blocker fields")
        const target = yield* reference(raw.target, scope, additions)
        const reason = yield* leaf(Schema.NullOr(TextSchema), raw.reason)
        return freezeMutation({ op: "block", target, reason })
      }
      default:
        return yield* invalid("invalid_operation", "Unknown task operation")
    }
  })

export const decodeTaskMutationBatch = (
  input: unknown,
): Result<TaskMutationBatch> =>
  Either.gen(function* () {
    if (!shape(input, ["issues", "operations"], ["issues", "operations"]))
      return yield* invalid(
        "invalid_batch",
        "A task batch requires only explicit issues and operations",
      )
    const decodedScope = decodeIssueScope(input.issues)
    if (Either.isLeft(decodedScope))
      return yield* invalid(
        "invalid_batch",
        "Task batch requires a bounded, distinct qualified issue scope",
      )
    if (!Array.isArray(input.operations) || input.operations.length === 0)
      return yield* invalid(
        "invalid_batch",
        "A task batch requires nonempty operations",
      )
    if (input.operations.length > MAX_TASK_MUTATIONS)
      return yield* invalid(
        "capacity",
        "Too many operations in one atomic batch",
      )
    const scope = new Set(decodedScope.right.map(issueKey))
    const additions = new Set<string>()
    const operations: TaskMutation[] = []
    let references = 0
    let textSize = 0
    for (const value of input.operations) {
      const operation = yield* mutation(value, scope, additions)
      switch (operation.op) {
        case "add":
          references += operation.dependsOn.length
          textSize += operation.text.length
          additions.add(draftIdentity(operation.issue, operation.key))
          break
        case "edit":
          references += 1 + (operation.dependsOn?.length ?? 0)
          textSize += operation.text?.length ?? 0
          break
        case "status":
          references += 1
          break
        case "block":
          references += 1
          textSize += operation.reason === null ? 0 : operation.reason.length
          break
      }
      if (references > MAX_BATCH_REFERENCES || textSize > MAX_BATCH_TEXT)
        return yield* invalid(
          "capacity",
          "Atomic task batch exceeds its aggregate reference or text budget",
        )
      operations.push(operation)
    }
    return Object.freeze({
      issues: decodedScope.right,
      operations: Object.freeze(operations),
    })
  })
