import { Effect, Either } from "effect"
import type {
  RegistryOutcomeRequest,
  RegistryOutcomeResult,
} from "../shared/registry-intent-events.ts"
import {
  NOT_ENTITLED_TO_CLOSE,
  type RegistryError,
  type RegistryRequest,
  type RegistrySnapshot,
  type RegistryStore,
} from "./registry.ts"

const MAX_ENVELOPE_SUMMARY = 2_000
const MAX_REPORTED_SUMMARY = 4_000
const MAX_SENDER_ID = 128
const REQUEST_ID_SHAPE = /^[0-9a-f][0-9a-f-]{7,35}$/

/**
 * One outcome envelope as it arrived over the bridge. `senderId` is the bridge
 * agent that sent it; it is undefined when the envelope carried no attributable
 * sender, which entitles it to close nothing.
 */
export interface ReportedRequestOutcome {
  readonly requestId: string
  readonly resolution: "completed" | "failed"
  readonly summary: string
  readonly senderId: string | undefined
  readonly now: number
}

/**
 * Why an outcome envelope cannot be recorded at all, or undefined when its
 * shape is sound.
 *
 * The envelope is parsed from bridge text, so a truncated request id or an
 * over-long summary is an ordinary arrival rather than a programming fault.
 * Naming the violated field is what lets the emitter answer its sender instead
 * of dropping the envelope silently and leaving it to be re-sent forever.
 */
export const outcomeEnvelopeRejection: (
  payload: RegistryOutcomeRequest,
) => string | undefined = (payload) => {
  if (
    typeof payload.requestId !== "string" ||
    !REQUEST_ID_SHAPE.test(payload.requestId)
  )
    return "request id must be a hex request id or a bounded prefix of one"
  if (payload.resolution !== "completed" && payload.resolution !== "failed")
    return "resolution must be completed or failed"
  if (
    typeof payload.summary !== "string" ||
    payload.summary.length === 0 ||
    payload.summary.length > MAX_REPORTED_SUMMARY
  )
    return `summary must contain 1-${MAX_REPORTED_SUMMARY} characters`
  if (
    payload.senderId !== undefined &&
    (typeof payload.senderId !== "string" ||
      payload.senderId.length === 0 ||
      payload.senderId.length > MAX_SENDER_ID)
  )
    return `sender id must contain 1-${MAX_SENDER_ID} characters`
  return undefined
}

/**
 * Record a receiver's outcome envelope against the routed request it names.
 *
 * The workflow keeps the store's typed failure channel: every outcome the
 * dispatch flow is meant to relay back to the reporter - an unknown or
 * ambiguous request id, an unentitled sender, a request already terminal - is a
 * `RegistryOutcomeResult` value, and only a genuine store failure travels in
 * the `RegistryError` channel for the caller to render once at the edge.
 */
export const recordRequestOutcome: (
  store: RegistryStore,
  reported: ReportedRequestOutcome,
) => Effect.Effect<RegistryOutcomeResult, RegistryError> = (store, reported) =>
  Effect.gen(function* () {
    const senderId = reported.senderId
    if (senderId === undefined) {
      return {
        outcome: "failed",
        reason: "outcome envelope carries no sender",
      } as const
    }
    const snapshot = yield* store.snapshot(reported.now)
    const matches = snapshot.requests.filter((request) =>
      request.id.startsWith(reported.requestId),
    )
    const target = matches.length === 1 ? matches[0] : undefined
    if (!target) {
      return {
        outcome: "failed",
        reason:
          matches.length === 0
            ? "request not found"
            : "request id prefix is ambiguous",
      } as const
    }
    // Entitlement is decided before anything about the row's status is
    // reported. A sender that is not a party to the request learns the same
    // thing whether the row is open or closed, so a bridge actor cannot map the
    // queue by prefix or be told its close succeeded on work it was never given.
    if (!entitledToClose(snapshot, target, senderId)) {
      return { outcome: "failed", reason: NOT_ENTITLED_TO_CLOSE } as const
    }
    // A receiver that never saw the dispatcher's acknowledgement re-sends the
    // same envelope on its next drain. The row is already closed, so report the
    // outcome as recorded rather than as a lost race.
    if (target.status !== "queued" && target.status !== "claimed") {
      return { outcome: "recorded" } as const
    }
    const summary = reported.summary.slice(0, MAX_ENVELOPE_SUMMARY)
    const resolved = yield* Effect.either(
      store.resolveRequest({
        requestId: target.id,
        reporterId: senderId,
        outcome:
          reported.resolution === "completed"
            ? { resolution: "completed", summary }
            : { resolution: "failed", failure: "error", diagnostic: summary },
        now: reported.now,
      }),
    )
    if (Either.isRight(resolved)) return { outcome: "recorded" } as const
    // The store's terminal transition is fenced on the row still being open, so
    // a lost race means another writer closed it in the gap after the snapshot.
    // The reporter asked for a terminal row and has one; re-sending the envelope
    // would only lose the same race again.
    if (resolved.left.code === "invalid_transition")
      return { outcome: "recorded" } as const
    if (resolved.left.code === "not_entitled")
      return { outcome: "failed", reason: resolved.left.message } as const
    return yield* Effect.fail(resolved.left)
  })

/**
 * Whether a sender may close this row: the bridge agent the request was routed
 * to, or the session holding the project role lease. The store fences the same
 * rule inside its transaction and stays authoritative - a lease can expire in
 * the gap - but the decision has to be available here to be made first.
 */
const entitledToClose: (
  snapshot: RegistrySnapshot,
  target: RegistryRequest,
  senderId: string,
) => boolean = (snapshot, target, senderId) =>
  target.assignedAgentId === senderId ||
  snapshot.leases.some(
    (lease) =>
      lease.project === target.project &&
      lease.role === target.role &&
      lease.owner.id === senderId &&
      lease.status === "active",
  )
