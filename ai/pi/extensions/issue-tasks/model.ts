import { Schema } from "effect"
import type { IssueReference } from "./identity.ts"

export const TaskIdSchema = Schema.UUID.pipe(
  Schema.brand("IssueTaskId"),
  Schema.filter(value => value === value.toLowerCase()),
)

export const MutationBatchIdSchema = Schema.UUID.pipe(
  Schema.brand("TaskMutationBatchId"),
  Schema.filter(value => value === value.toLowerCase()),
)

export const RevisionSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

export const MAX_TASK_TEXT = 131_072

export const MAX_TASK_PAGE_SIZE = 100

export const TextSchema = Schema.String.pipe(
  Schema.maxLength(MAX_TASK_TEXT),
  Schema.filter(value => value.trim().length > 0),
  Schema.filter(
    value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
  ),
)

export const UnitStatusSchema = Schema.Literal(
  "todo",
  "doing",
  "done",
  "cancelled",
)

export const BlockedReasonSchema = TextSchema.pipe(
  Schema.brand("TaskBlockedReason"),
)

export const StatusSchema = Schema.Union(
  UnitStatusSchema,
  Schema.TaggedStruct("blocked", { reason: BlockedReasonSchema }),
)

export const StatusFilterSchema = Schema.Literal(
  "todo",
  "doing",
  "done",
  "cancelled",
  "blocked",
)

export type UnitTaskStatus = typeof UnitStatusSchema.Type

export type BlockedReason = typeof BlockedReasonSchema.Type

export type TaskId = typeof TaskIdSchema.Type

export type TaskStatus = typeof StatusSchema.Type

export type MutationBatchId = typeof MutationBatchIdSchema.Type

export interface IssueTaskRevision {
  readonly issue: IssueReference
  readonly revision: number
}

export const storedTaskStatus = (
  status: UnitTaskStatus,
  reason: BlockedReason | null,
): TaskStatus =>
  status === "done" || status === "cancelled" || reason === null
    ? status
    : Object.freeze({ _tag: "blocked", reason })

export interface IssueTask {
  readonly id: TaskId
  readonly text: string
  readonly status: TaskStatus
}

export interface IssueTaskPage extends IssueTaskRevision {
  readonly tasks: readonly IssueTask[]
  readonly next: TaskId | null
}

export interface TaskAddress {
  readonly issue: IssueReference
  readonly id: TaskId
}

export interface IssueTaskDetail extends IssueTaskRevision {
  readonly task: IssueTask
  readonly dependsOn: readonly TaskAddress[]
}

export interface IssueTaskCounts {
  readonly total: number
  readonly todo: number
  readonly doing: number
  readonly done: number
  readonly cancelled: number
  readonly blocked: number
}

export interface IssueTaskProgress extends IssueTaskRevision {
  readonly counts: IssueTaskCounts
  readonly currentTask:
    | (IssueTask & {
        readonly status: Exclude<TaskStatus, "done" | "cancelled">
      })
    | null
}

export interface TaskFilter {
  readonly status?: typeof StatusFilterSchema.Type
}

export const TaskFilterSchema = Schema.Unknown.pipe(
  Schema.filter(
    value =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Reflect.ownKeys(value).every(key => key === "status"),
  ),
  Schema.compose(
    Schema.Struct({
      status: Schema.optional(StatusFilterSchema),
    }),
  ),
)

export interface TaskPageInput {
  readonly limit: number
  readonly after?: TaskId
}

export interface TaskReadQuery {
  readonly issue: IssueReference
  readonly page: TaskPageInput
  readonly filter?: TaskFilter
}

export interface IssueTaskPageResult {
  readonly issue: IssueReference
  readonly page: IssueTaskPage | null
}
