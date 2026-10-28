import { Schema } from "effect"
import type { IssueReference } from "./identity.ts"

export const PlanIdSchema = Schema.UUID.pipe(
  Schema.brand("IssuePlanId"),
  Schema.filter(value => value === value.toLowerCase()),
)
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
export const TextSchema = Schema.String.pipe(
  Schema.maxLength(131_072),
  Schema.filter(value => value.trim().length > 0),
  Schema.filter(
    value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
  ),
)
export const StatusSchema = Schema.Literal("todo", "doing", "done", "cancelled")

export type PlanId = typeof PlanIdSchema.Type
export type TaskId = typeof TaskIdSchema.Type
export type TaskStatus = typeof StatusSchema.Type
export type MutationBatchId = typeof MutationBatchIdSchema.Type

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
