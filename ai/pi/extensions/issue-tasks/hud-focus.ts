import { Data, Either, Option } from "effect"
import type { IssueReference } from "./identity.ts"
import { decodeIssueNextQuery } from "./next.ts"
import * as presentation from "./render.ts"

export type TaskHudFocus =
  | { readonly kind: "none" }
  | { readonly kind: "unconfirmed" }
  | {
      readonly kind: "issue"
      readonly issue: IssueReference
      readonly mode: "implementation" | "review"
    }

export class TaskHudFocusError extends Data.TaggedError("TaskHudFocusError")<{
  readonly code: "invalid_state" | "selection_failed" | "unavailable"
}> {}

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const error = (code: TaskHudFocusError["code"]) =>
  new TaskHudFocusError({ code })

export const taskNextHudFocus = (
  args: unknown,
  details: unknown,
): Either.Either<Option.Option<TaskHudFocus>, TaskHudFocusError> =>
  Either.gen(function* () {
    if (!record(args) || args.action !== "next") return Option.none()
    if (Reflect.ownKeys(args).some(key => key !== "action" && key !== "query"))
      return yield* Either.left(error("invalid_state"))
    const query = yield* decodeIssueNextQuery(args.query).pipe(
      Either.mapLeft(() => error("invalid_state")),
    )
    if (
      !record(details) ||
      (details.output !== "complete" && details.output !== "unavailable") ||
      !record(details.outcome)
    )
      return yield* Either.left(error("invalid_state"))
    const outcome = details.outcome
    if (
      outcome.kind === "unknown" ||
      outcome.kind === "unconfirmed" ||
      outcome.kind === "interrupted"
    )
      return Option.some(Object.freeze({ kind: "unconfirmed" as const }))
    if (outcome.kind === "failed")
      return yield* Either.left(error("selection_failed"))
    if (outcome.kind !== "issue_next")
      return yield* Either.left(error("invalid_state"))

    // Older still-loaded renderer modules have no projection export. Never
    // substitute legacy task state while a coherent reload is still required.
    const decode = presentation.decodeTaskNextResult
    if (typeof decode !== "function")
      return yield* Either.left(error("unavailable"))
    const next = yield* decode(outcome.result).pipe(
      Either.mapLeft(() => error("invalid_state")),
    )
    if (next.kind === "none")
      return Option.some(Object.freeze({ kind: "none" as const }))
    const mode = query.mode ?? "implementation"
    if ((next.kind === "review") !== (mode === "review"))
      return yield* Either.left(error("invalid_state"))
    const issue =
      next.kind === "review"
        ? next.observed.issue
        : next.receipt.trace.target.issue
    if (issue.repository !== query.repository)
      return yield* Either.left(error("invalid_state"))
    if (next.kind === "pickup" && next.receipt.kind !== "verified")
      return Option.some(Object.freeze({ kind: "unconfirmed" as const }))
    return Option.some(
      Object.freeze({
        kind: "issue" as const,
        issue: Object.freeze({ ...issue }),
        mode,
      }),
    )
  })

type PendingTaskCall =
  | { readonly kind: "call"; readonly args: unknown }
  | { readonly kind: "ambiguous" }

export const currentIssueFromEntries = (
  entries: readonly unknown[],
): Either.Either<TaskHudFocus, TaskHudFocusError> => {
  if (!Array.isArray(entries)) return Either.left(error("invalid_state"))
  const pending = new Map<string, PendingTaskCall>()
  let latest: string | undefined
  let current: Either.Either<TaskHudFocus, TaskHudFocusError> = Either.right({
    kind: "none",
  })

  for (const entry of entries) {
    if (!record(entry) || entry.type !== "message" || !record(entry.message))
      continue
    const message = entry.message
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) {
        if (
          !record(call) ||
          call.type !== "toolCall" ||
          call.name !== "task" ||
          typeof call.id !== "string" ||
          call.id.length === 0
        )
          continue
        const changesFocus =
          record(call.arguments) && call.arguments.action === "next"
        if (changesFocus) latest = call.id
        if (pending.has(call.id)) {
          pending.set(call.id, { kind: "ambiguous" })
          if (call.id === latest) current = Either.left(error("invalid_state"))
        } else {
          pending.set(call.id, { kind: "call", args: call.arguments })
          if (changesFocus) current = Either.right({ kind: "unconfirmed" })
        }
      }
    }
    if (
      message.role !== "toolResult" ||
      message.toolName !== "task" ||
      typeof message.toolCallId !== "string"
    )
      continue
    const request = pending.get(message.toolCallId)
    if (request === undefined) continue
    pending.delete(message.toolCallId)
    if (message.toolCallId !== latest) continue
    latest = undefined
    const projected =
      request.kind === "ambiguous"
        ? Either.left(error("invalid_state"))
        : taskNextHudFocus(request.args, message.details)
    current = Either.isLeft(projected)
      ? Either.left(projected.left)
      : Option.match(projected.right, {
          onNone: () => current,
          onSome: focus => Either.right(focus),
        })
  }
  return current
}
