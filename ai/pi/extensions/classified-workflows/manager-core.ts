import { Data, Either, Effect, Option } from "effect"
import { decodeTodoState, validateTodoState, type Todo } from "../todo/state.ts"

export const MANAGER_PRIORITY_ENTRY = "pi.manager-priorities.v1"
export const MANAGER_CHAT_ENTRY = "pi.manager-chat.v1"
export const MANAGER_SUMMARY_ENTRY = "pi.manager-summary.v1"

export class ManagerError extends Data.TaggedError("ManagerError")<{
  readonly code:
    | "invalid_input"
    | "invalid_state"
    | "busy"
    | "cancelled"
    | "model_failed"
    | "model_output"
    | "session_changed"
  readonly message: string
}> {}
export interface ManagerTurn {
  readonly question: string
  readonly answer: string
}
export interface ManagerPriorities {
  readonly version: 1
  readonly ids: readonly number[]
}
export interface ManagerObservation {
  readonly tasks: readonly {
    readonly id: number
    readonly title: string
    readonly status: string
    readonly priority?: number
  }[]
  readonly completedIds: readonly number[]
  readonly total: number
  readonly omitted: number
}
export type ManagerSummary = {
  readonly version: 1
  readonly round: number
} & (
  | { readonly status: "started" }
  | {
      readonly status: "completed" | "failed"
      readonly text: string
      readonly elapsedMs: number
    }
)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
const invalid = (message: string) =>
  Either.left(new ManagerError({ code: "invalid_state", message }))
const latestData = (
  entries: readonly unknown[],
  kind: string,
): Option.Option<unknown> => {
  for (const entry of entries.toReversed())
    if (record(entry) && entry.type === "custom" && entry.customType === kind)
      return Option.some(entry.data)
  return Option.none()
}

export const readManagerTasks = (
  entries: readonly unknown[],
): Either.Either<readonly Todo[], ManagerError> => {
  let state: Option.Option<unknown> = Option.none()
  for (const entry of entries.toReversed()) {
    if (!record(entry)) continue
    if (entry.type === "custom" && entry.customType === "todo.state") {
      state = Option.some(entry.data)
      break
    }
    if (
      entry.type === "message" &&
      record(entry.message) &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "todo" &&
      record(entry.message.details) &&
      "state" in entry.message.details
    ) {
      state = Option.some(entry.message.details.state)
      break
    }
  }
  if (Option.isNone(state)) return Either.right([])
  const decoded = decodeTodoState(state.value)
  if (Option.isNone(decoded) || decoded.value.todos.length > 5000)
    return invalid("Worker task snapshot is malformed or too large.")
  const checked = Effect.runSync(
    Effect.either(validateTodoState(decoded.value)),
  )
  return Either.isLeft(checked)
    ? invalid(checked.left.message)
    : Either.right(checked.right.todos)
}

export const parseManagerPriorities = (
  text: string,
  tasks: readonly Todo[],
): Either.Either<ManagerPriorities, ManagerError> => {
  if (text.trim() === "clear") return Either.right({ version: 1, ids: [] })
  const parts = text.trim().split(/\s+/u)
  if (parts.length > 64 || !parts.every(part => /^[1-9][0-9]*$/u.test(part)))
    return Either.left(
      new ManagerError({
        code: "invalid_input",
        message: "Use up to 64 distinct task IDs, or priorities clear.",
      }),
    )
  const ids = parts.map(Number)
  if (
    !ids.every(positiveId) ||
    new Set(ids).size !== ids.length ||
    !ids.every(id =>
      tasks.some(
        task =>
          task.id === id &&
          ["pending", "in_progress", "in_review"].includes(task.status) &&
          (task.parentId === undefined ||
            tasks.some(
              parent =>
                parent.id === task.parentId &&
                parent.parentId === undefined &&
                parent.status !== "blocked" &&
                parent.status !== "deferred",
            )),
      ),
    )
  )
    return Either.left(
      new ManagerError({
        code: "invalid_input",
        message:
          "Priorities must name distinct existing runnable tasks; paused tasks are not resumed.",
      }),
    )
  return Either.right({ version: 1, ids })
}

export const readManagerPriorities = (
  entries: readonly unknown[],
): Either.Either<ManagerPriorities | undefined, ManagerError> => {
  const latest = latestData(entries, MANAGER_PRIORITY_ENTRY)
  if (Option.isNone(latest)) return Either.right(undefined)
  const value = latest.value
  if (
    !record(value) ||
    value.version !== 1 ||
    Object.keys(value).some(key => key !== "version" && key !== "ids") ||
    !Array.isArray(value.ids) ||
    value.ids.length > 64 ||
    !value.ids.every(positiveId) ||
    new Set(value.ids).size !== value.ids.length
  )
    return invalid(
      "Stored manager priorities are malformed; use /manager priorities clear to repair them.",
    )
  return Either.right({ version: 1, ids: value.ids })
}

export const orderManagerTasks = <
  T extends { readonly id: number; readonly priority?: number },
>(
  tasks: readonly T[],
  priorities: ManagerPriorities | undefined,
): readonly T[] => {
  if (!priorities && tasks.every(task => task.priority === undefined))
    return tasks
  const ranks = new Map(priorities?.ids.map((id, index) => [id, index]) ?? [])
  return [...tasks].sort((left, right) => {
    if (left.priority !== right.priority) {
      if (left.priority === undefined) return 1
      if (right.priority === undefined) return -1
      return left.priority < right.priority ? -1 : 1
    }
    const leftOrder = ranks.get(left.id)
    const rightOrder = ranks.get(right.id)
    if (leftOrder === rightOrder) return 0
    if (leftOrder === undefined) return 1
    if (rightOrder === undefined) return -1
    return leftOrder - rightOrder
  })
}

export const managerObservation = (
  tasks: readonly Todo[],
  priorities?: ManagerPriorities,
): ManagerObservation => {
  const statusRank: Readonly<Record<Todo["status"], number>> = {
    in_progress: 0,
    in_review: 1,
    pending: 2,
    blocked: 3,
    deferred: 4,
    completed: 5,
    cancelled: 6,
  }
  const recentWork = tasks
    .toReversed()
    .sort((left, right) => statusRank[left.status] - statusRank[right.status])
  const ordered = orderManagerTasks(recentWork, priorities)
  const visible = ordered
    .filter(task => task.status !== "completed" && task.status !== "cancelled")
    .slice(0, 24)
  return {
    tasks: visible.map(task => ({
      id: task.id,
      title: Array.from(task.text).slice(0, 240).join(""),
      status: task.status,
      ...(task.priority === undefined ? {} : { priority: task.priority }),
    })),
    completedIds: tasks
      .filter(task => task.status === "completed")
      .map(task => task.id),
    total: tasks.length,
    omitted: tasks.length - visible.length,
  }
}

export const readManagerTurns = (
  entries: readonly unknown[],
): Either.Either<readonly ManagerTurn[], ManagerError> => {
  const latest = latestData(entries, MANAGER_CHAT_ENTRY)
  if (Option.isNone(latest)) return Either.right([])
  const value = latest.value
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.turns) ||
    value.turns.length > 12
  )
    return invalid(
      "Stored manager conversation is malformed; use /manager reset to clear it.",
    )
  const turns: ManagerTurn[] = []
  for (const turn of value.turns) {
    if (
      !record(turn) ||
      typeof turn.question !== "string" ||
      turn.question.length === 0 ||
      turn.question.length > 4000 ||
      typeof turn.answer !== "string" ||
      turn.answer.length === 0 ||
      turn.answer.length > 12000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(
        turn.question + turn.answer,
      )
    )
      return invalid("Stored manager conversation contains an invalid turn.")
    turns.push({ question: turn.question, answer: turn.answer })
  }
  return Either.right(turns)
}

export const decodeManagerSummary = (
  value: unknown,
): Either.Either<ManagerSummary, ManagerError> => {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.round !== "number" ||
    !Number.isSafeInteger(value.round) ||
    value.round < 0
  ) {
    return invalid("Stored manager summary has an invalid round identity.")
  }

  if (value.status === "started") {
    return Either.right({ version: 1, round: value.round, status: "started" })
  }

  if (
    (value.status !== "completed" && value.status !== "failed") ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 12000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text) ||
    typeof value.elapsedMs !== "number" ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0
  ) {
    return invalid("Stored manager summary has an invalid result.")
  }

  return Either.right({
    version: 1,
    round: value.round,
    status: value.status,
    text: value.text,
    elapsedMs: value.elapsedMs,
  })
}

export const managerSummaryExists = (
  entries: readonly unknown[],
  round: number,
): Either.Either<boolean, ManagerError> => {
  for (const entry of entries.toReversed()) {
    if (
      !record(entry) ||
      entry.type !== "custom" ||
      entry.customType !== MANAGER_SUMMARY_ENTRY
    )
      continue
    const decoded = decodeManagerSummary(entry.data)
    if (Either.isLeft(decoded)) return Either.left(decoded.left)
    if (decoded.right.round === round) return Either.right(true)
  }
  return Either.right(false)
}
