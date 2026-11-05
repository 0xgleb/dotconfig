import { Data, Either } from "effect"
import { issueKey, type IssueReference } from "./identity.ts"
import type {
  IssueTaskRevision,
  IssueTask,
  TaskId,
  TaskStatus,
} from "./model.ts"
import type {
  DraftTaskKey,
  TaskMutationBatch,
  TaskReference,
} from "./mutations.ts"

export interface CurrentTask extends IssueTask {
  readonly issue: IssueReference
  readonly dependsOn: readonly TaskId[]
}

export interface DependencyNode {
  readonly id: TaskId
  readonly dependsOn: readonly TaskId[]
}

export type IssueCandidate =
  | { readonly kind: "stored"; readonly state: IssueTaskRevision }
  | {
      readonly kind: "new"
      readonly state: IssueTaskRevision & { readonly revision: 0 }
    }

export interface TaskSnapshot {
  readonly issues: readonly IssueCandidate[]
  readonly tasks: readonly CurrentTask[]
  readonly external: readonly DependencyNode[]
}

export interface TaskIdAllocation {
  readonly issue: IssueReference
  readonly key: DraftTaskKey
  readonly id: TaskId
}

/** Trusted host policy and generated IDs; never deserialize this from model input. */
export interface TaskMutationContext {
  readonly cancellation: "forbidden" | "owner-authorized"
  readonly additions: readonly TaskIdAllocation[]
}

export type EditChange =
  | { readonly field: "text"; readonly before: string; readonly after: string }
  | {
      readonly field: "dependsOn"
      readonly before: readonly TaskId[]
      readonly after: readonly TaskId[]
    }

export type TaskEvent =
  | {
      readonly op: "add"
      readonly operationIndex: number
      readonly task: CurrentTask
    }
  | {
      readonly op: "edit"
      readonly operationIndex: number
      readonly issue: IssueReference
      readonly id: TaskId
      readonly changes: readonly [EditChange, ...EditChange[]]
    }
  | {
      readonly op: "status"
      readonly operationIndex: number
      readonly issue: IssueReference
      readonly id: TaskId
      readonly before: TaskStatus
      readonly after: TaskStatus
    }
  | {
      readonly op: "block"
      readonly operationIndex: number
      readonly issue: IssueReference
      readonly id: TaskId
      readonly before: string | null
      readonly after: string | null
    }
  | {
      readonly op: "transfer"
      readonly operationIndex: number
      readonly issue: IssueReference
      readonly id: TaskId
      readonly splitFrom: IssueReference
    }

export interface TaskChangeSummary {
  readonly issue: IssueReference
  readonly id: TaskId
  readonly revision: number
  readonly fields: readonly (
    "text" | "dependsOn" | "status" | "blocker" | "issue"
  )[]
}

export interface PreparedIssueChange {
  readonly kind: "stored" | "new"
  readonly state: IssueTaskRevision
}

export interface PreparedTaskChanges {
  readonly issues: readonly PreparedIssueChange[]
  readonly tasks: readonly CurrentTask[]
  readonly events: readonly TaskEvent[]
  readonly changed: readonly TaskChangeSummary[]
}

export const MAX_TRANSITION_NODES = 10_000
export const MAX_TRANSITION_EDGES = 100_000
export const MAX_TRANSITION_TEXT = 8_388_608

export class TaskTransitionError extends Data.TaggedError(
  "TaskTransitionError",
)<{
  readonly code:
    | "corrupt_state"
    | "scope_mismatch"
    | "missing_task"
    | "invalid_allocation"
    | "unauthorized"
    | "cycle"
    | "revision_exhausted"
    | "capacity"
  readonly message: string
}> {}

type Result<A> = Either.Either<A, TaskTransitionError>
type ChangedField = TaskChangeSummary["fields"][number]

const fail = (
  code: TaskTransitionError["code"],
  message: string,
): Result<never> => Either.left(new TaskTransitionError({ code, message }))
const aliasKey = (issue: IssueReference, key: DraftTaskKey): string =>
  `${issueKey(issue)}:${key}`
const frozenIssue = (issue: IssueReference): IssueReference =>
  Object.freeze({ repository: issue.repository, number: issue.number })
const frozenTask = (task: CurrentTask): CurrentTask =>
  Object.freeze({
    issue: frozenIssue(task.issue),
    id: task.id,
    text: task.text,
    status: task.status,
    blocker: task.blocker,
    dependsOn: Object.freeze([...task.dependsOn].sort()),
  })
const equalIds = (
  first: readonly TaskId[],
  second: readonly TaskId[],
): boolean =>
  first.length === second.length &&
  first.every((id, index) => id === second[index])

const validateGraph = (
  graph: ReadonlyMap<TaskId, readonly TaskId[]>,
): Result<void> => {
  if (graph.size > MAX_TRANSITION_NODES)
    return fail("capacity", "Task dependency component is too large")

  const incoming = new Map<TaskId, number>(
    Array.from(graph.keys(), id => [id, 0]),
  )
  let edgeCount = 0
  for (const dependencies of graph.values()) {
    edgeCount += dependencies.length
    if (edgeCount > MAX_TRANSITION_EDGES)
      return fail("capacity", "Task dependency component has too many edges")
    if (new Set(dependencies).size !== dependencies.length)
      return fail("corrupt_state", "Persisted dependency edges are duplicated")
    for (const id of dependencies) {
      const count = incoming.get(id)
      if (count === undefined)
        return fail("corrupt_state", "Task dependency closure is incomplete")

      incoming.set(id, count + 1)
    }
  }

  const ready: TaskId[] = []
  for (const [id, count] of incoming) if (count === 0) ready.push(id)

  let visited = 0
  while (visited < ready.length) {
    const id = ready[visited]
    if (id === undefined)
      return fail("corrupt_state", "Invalid dependency traversal position")

    const dependencies = graph.get(id)
    if (dependencies === undefined)
      return fail("corrupt_state", "Dependency traversal lost a node")

    for (const dependency of dependencies) {
      const count = incoming.get(dependency)
      if (count === undefined || count <= 0)
        return fail("corrupt_state", "Invalid dependency degree")

      incoming.set(dependency, count - 1)
      if (count === 1) ready.push(dependency)
    }
    visited += 1
  }

  return visited === graph.size
    ? Either.right(undefined)
    : fail("cycle", "Task dependencies contain a cycle")
}

export const prepareTaskChanges = (
  batch: TaskMutationBatch,
  snapshot: TaskSnapshot,
  context: TaskMutationContext,
): Result<PreparedTaskChanges> =>
  Either.gen(function* () {
    if (
      context.cancellation !== "forbidden" &&
      context.cancellation !== "owner-authorized"
    )
      return yield* fail("unauthorized", "Cancellation policy is unavailable")
    if (snapshot.tasks.length + snapshot.external.length > MAX_TRANSITION_NODES)
      return yield* fail("capacity", "Task dependency component is too large")

    const scope = new Set(batch.issues.map(issueKey))
    const issueStates = new Map<string, IssueCandidate>()
    for (const candidate of snapshot.issues) {
      const key = issueKey(candidate.state.issue)
      const revision = candidate.state.revision
      if (
        !scope.has(key) ||
        issueStates.has(key) ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        (candidate.kind === "new" && revision !== 0)
      )
        return yield* fail(
          "corrupt_state",
          "Invalid or duplicated issue task state",
        )

      issueStates.set(key, candidate)
    }

    const tasks = new Map<TaskId, CurrentTask>()
    const graph = new Map<TaskId, readonly TaskId[]>()
    let textSize = 0
    for (const task of snapshot.tasks) {
      const candidate = issueStates.get(issueKey(task.issue))
      if (
        candidate === undefined ||
        candidate.kind !== "stored" ||
        tasks.has(task.id)
      )
        return yield* fail(
          "corrupt_state",
          "Invalid or duplicated task projection",
        )

      textSize +=
        task.text.length + (task.blocker === null ? 0 : task.blocker.length)
      if (textSize > MAX_TRANSITION_TEXT)
        return yield* fail(
          "capacity",
          "Current task text exceeds the transaction budget",
        )

      const current = frozenTask(task)
      tasks.set(current.id, current)
      graph.set(current.id, current.dependsOn)
    }

    for (const node of snapshot.external) {
      if (graph.has(node.id))
        return yield* fail("corrupt_state", "Dependency projections overlap")
      graph.set(node.id, Object.freeze([...node.dependsOn]))
    }

    yield* validateGraph(graph)

    const initialIds = new Set(tasks.keys())
    const expected = new Set<string>()
    for (const operation of batch.operations)
      if (operation.op === "add") {
        const key = aliasKey(operation.issue, operation.key)
        if (expected.has(key))
          return yield* fail(
            "invalid_allocation",
            "Draft additions are duplicated",
          )
        expected.add(key)
      }

    const allocations = new Map<string, TaskId>()
    const allocatedIds = new Set<TaskId>()
    for (const addition of context.additions) {
      const key = aliasKey(addition.issue, addition.key)
      if (
        !expected.has(key) ||
        allocations.has(key) ||
        graph.has(addition.id) ||
        allocatedIds.has(addition.id)
      )
        return yield* fail(
          "invalid_allocation",
          "Generated task identities do not match fresh draft additions",
        )

      allocations.set(key, addition.id)
      allocatedIds.add(addition.id)
    }
    if (allocations.size !== expected.size)
      return yield* fail(
        "invalid_allocation",
        "A draft addition has no generated task identity",
      )

    const resolve = (reference: TaskReference): Result<CurrentTask> => {
      const id =
        reference.task.kind === "existing"
          ? reference.task.id
          : allocations.get(aliasKey(reference.issue, reference.task.key))
      if (
        id === undefined ||
        (reference.task.kind === "existing" && !initialIds.has(id))
      )
        return fail(
          "missing_task",
          "Referenced task does not exist in the current issue scope",
        )

      const task = tasks.get(id)
      if (task === undefined)
        return fail("missing_task", "Referenced task has not been created")
      if (
        reference.task.kind === "existing" &&
        issueKey(task.issue) !== issueKey(reference.issue)
      )
        return fail("scope_mismatch", "Task identity belongs to another issue")

      return Either.right(task)
    }

    const dependencies = (
      references: readonly TaskReference[],
    ): Result<readonly TaskId[]> =>
      Either.gen(function* () {
        const ids: TaskId[] = []
        for (const reference of references)
          ids.push((yield* resolve(reference)).id)

        if (new Set(ids).size !== ids.length)
          return yield* fail(
            "corrupt_state",
            "Dependency references resolve to duplicate task identities",
          )

        return Object.freeze(ids.sort())
      })

    const events: TaskEvent[] = []
    const changedIssues = new Set<string>()
    const touched = new Map<TaskId, Set<ChangedField>>()
    const mark = (id: TaskId, fields: readonly ChangedField[]): void => {
      const prior = touched.get(id)
      const current = prior === undefined ? new Set<ChangedField>() : prior
      for (const field of fields) current.add(field)
      touched.set(id, current)
    }

    const record = (event: TaskEvent): void => {
      const issue = event.op === "add" ? event.task.issue : event.issue
      changedIssues.add(issueKey(issue))
      if (event.op === "transfer") changedIssues.add(issueKey(event.splitFrom))
      events.push(Object.freeze(event))
    }

    for (const [operationIndex, operation] of batch.operations.entries()) {
      if (operation.op === "add") {
        if (!issueStates.has(issueKey(operation.issue)))
          return yield* fail(
            "corrupt_state",
            "A scoped addition has no issue task state",
          )

        const id = allocations.get(aliasKey(operation.issue, operation.key))
        if (id === undefined || tasks.has(id))
          return yield* fail(
            "invalid_allocation",
            "Draft task identity is missing or already used",
          )

        const dependsOn = yield* dependencies(operation.dependsOn)
        const task = frozenTask({
          issue: operation.issue,
          id,
          text: operation.text,
          status: "todo",
          blocker: null,
          dependsOn,
        })

        tasks.set(id, task)
        graph.set(id, task.dependsOn)
        record({ op: "add", operationIndex, task })
        mark(id, ["text", "status", "blocker", "dependsOn"])
        continue
      }

      const task = yield* resolve(operation.target)
      switch (operation.op) {
        case "edit": {
          const text = operation.text === undefined ? task.text : operation.text
          const dependsOn =
            operation.dependsOn === undefined
              ? task.dependsOn
              : yield* dependencies(operation.dependsOn)
          const changes: EditChange[] = []
          if (text !== task.text)
            changes.push(
              Object.freeze({ field: "text", before: task.text, after: text }),
            )
          if (!equalIds(dependsOn, task.dependsOn))
            changes.push(
              Object.freeze({
                field: "dependsOn",
                before: task.dependsOn,
                after: dependsOn,
              }),
            )

          const [first, ...rest] = changes
          if (first === undefined) break

          const current = frozenTask({ ...task, text, dependsOn })
          tasks.set(current.id, current)
          graph.set(current.id, current.dependsOn)
          record({
            op: "edit",
            operationIndex,
            issue: current.issue,
            id: current.id,
            changes: Object.freeze([first, ...rest] as const),
          })
          mark(
            current.id,
            changes.map(change => change.field),
          )
          break
        }
        case "transfer": {
          if (!issueStates.has(issueKey(operation.toIssue)))
            return yield* fail(
              "corrupt_state",
              "Transfer destination has no issue task state",
            )
          if (issueKey(task.issue) === issueKey(operation.toIssue)) break

          const current = frozenTask({ ...task, issue: operation.toIssue })
          tasks.set(current.id, current)
          record({
            op: "transfer",
            operationIndex,
            issue: current.issue,
            id: current.id,
            splitFrom: task.issue,
          })
          mark(current.id, ["issue"])
          break
        }
        case "status": {
          if (
            context.cancellation !== "owner-authorized" &&
            (task.status === "cancelled" || operation.status === "cancelled")
          )
            return yield* fail(
              "unauthorized",
              "Cancelling or reopening tasks requires owner approval",
            )
          if (task.status === operation.status) break

          const current = frozenTask({ ...task, status: operation.status })
          tasks.set(current.id, current)
          record({
            op: "status",
            operationIndex,
            issue: current.issue,
            id: current.id,
            before: task.status,
            after: current.status,
          })
          mark(current.id, ["status"])
          break
        }
        case "block": {
          if (task.blocker === operation.reason) break

          const current = frozenTask({ ...task, blocker: operation.reason })
          tasks.set(current.id, current)
          record({
            op: "block",
            operationIndex,
            issue: current.issue,
            id: current.id,
            before: task.blocker,
            after: current.blocker,
          })
          mark(current.id, ["blocker"])
          break
        }
      }
    }

    let finalTextSize = 0
    for (const task of tasks.values()) {
      finalTextSize +=
        task.text.length + (task.blocker === null ? 0 : task.blocker.length)
      if (finalTextSize > MAX_TRANSITION_TEXT)
        return yield* fail(
          "capacity",
          "Final task text exceeds the transaction budget",
        )
    }

    yield* validateGraph(graph)

    const changedTasks: CurrentTask[] = []
    for (const id of touched.keys()) {
      const task = tasks.get(id)
      if (task === undefined)
        return yield* fail(
          "corrupt_state",
          "A changed task disappeared from its projection",
        )

      changedTasks.push(task)
      changedIssues.add(issueKey(task.issue))
    }

    const preparedIssues: PreparedIssueChange[] = []
    const revisions = new Map<string, number>()
    for (const issue of batch.issues) {
      const key = issueKey(issue)
      if (!changedIssues.has(key)) continue

      const candidate = issueStates.get(key)
      if (candidate === undefined)
        return yield* fail(
          "corrupt_state",
          "A changed task has no issue task state",
        )

      const revision = candidate.state.revision + 1
      if (!Number.isSafeInteger(revision))
        return yield* fail(
          "revision_exhausted",
          "Issue task revision cannot advance beyond the safe integer range",
        )

      const issueState = Object.freeze({
        issue: frozenIssue(issue),
        revision,
      })
      preparedIssues.push(
        Object.freeze({ kind: candidate.kind, state: issueState }),
      )
      revisions.set(key, revision)
    }

    const changed: TaskChangeSummary[] = []
    const fieldOrder: readonly ChangedField[] = [
      "text",
      "status",
      "blocker",
      "dependsOn",
      "issue",
    ]
    for (const task of changedTasks) {
      const fields = touched.get(task.id)
      const revision = revisions.get(issueKey(task.issue))
      if (fields === undefined || revision === undefined)
        return yield* fail(
          "corrupt_state",
          "A changed task has no revision or fields",
        )

      changed.push(
        Object.freeze({
          issue: task.issue,
          id: task.id,
          revision,
          fields: Object.freeze(fieldOrder.filter(field => fields.has(field))),
        }),
      )
    }

    return Object.freeze({
      issues: Object.freeze(preparedIssues),
      tasks: Object.freeze(changedTasks),
      events: Object.freeze(events),
      changed: Object.freeze(changed),
    })
  })
