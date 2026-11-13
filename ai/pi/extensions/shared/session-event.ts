import { Data, Schema } from "effect"
import { AttemptId, JobId } from "./job-attempt.ts"

// Session-side half of the v0.1 shared job and session event contract
// (SPEC "Jobs and worker pools" + ADR 01). A pool session is the durable
// execution context that runs job attempts: the interactive owning session
// and its workers.
//
// Identity-source decisions (recorded in todo #8 before this module):
// - SessionId identifies the Pi host session UUID (sessionManager
//   .getSessionId), the existing durable identity space. The agent-registry's
//   `${sessionId}:pid:${pid}` composite is a process-scoped lease identity
//   and is deliberately NOT used here: SPEC forbids process IDs in durable
//   identities.
// - Session events REFERENCE JobId/AttemptId from the merged attempt
//   contract; they never re-define execution events, which remain
//   attempt-owned.
// - Scope is session-level only: identity, capability declaration, job
//   assignment linkage, and session terminal state. Usage accounting,
//   cancellation, and outputs of execution are attempt events.
//
// This module owns the value contract only: no dispatch, no persistence, no
// admission or authority enforcement, and nothing here activates a pool.
const CanonicalUuid = Schema.UUID.pipe(Schema.pattern(/^[0-9a-f-]+$/))
export const SessionId = CanonicalUuid.pipe(Schema.brand("SessionId"))
export const SessionEventId = CanonicalUuid.pipe(Schema.brand("SessionEventId"))

const Counter = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Sequence = Counter.pipe(Schema.greaterThanOrEqualTo(1))

const SessionRole = Schema.Literal("coordinator", "worker")

const CapabilityModel = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(200),
)
const CapabilityTools = Schema.Array(
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
)
  .pipe(
    Schema.minItems(1),
    Schema.maxItems(16),
    Schema.filter(tools => new Set(tools).size === tools.length),
  )
  .annotations({
    message: () =>
      "declared tools must be a resolved, duplicate-free, non-empty set of bounded tool names",
  })

const sessionFields = {
  version: Schema.Literal(1),
  sessionId: SessionId,
  eventId: SessionEventId,
  sequence: Sequence,
  occurredAt: Counter,
}

export const SessionEvent = Schema.Union(
  Schema.Struct({
    ...sessionFields,
    kind: Schema.Literal("registered"),
    role: SessionRole,
    capabilities: Schema.Struct({
      model: CapabilityModel,
      reasoning: Schema.Literal(
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ),
      tools: CapabilityTools,
    }),
  }),
  Schema.Struct({
    ...sessionFields,
    kind: Schema.Literal("assigned"),
    jobId: JobId,
  }),
  Schema.Struct({
    ...sessionFields,
    kind: Schema.Literal("attempt-started"),
    jobId: JobId,
    attemptId: AttemptId,
  }),
  Schema.Struct({
    ...sessionFields,
    kind: Schema.Literal("attempt-released"),
    jobId: JobId,
    attemptId: AttemptId,
  }),
  Schema.Struct({
    ...sessionFields,
    kind: Schema.Literal("closed", "owner-lost"),
  }),
)
export type SessionEvent = typeof SessionEvent.Type

// Session-level acceptance state. The persistence owner reads the current
// snapshot and event receipt, then applies the acceptance decision in the
// same transaction, mirroring the merged attempt-event contract.
export const SessionIdentity = Schema.Struct({ sessionId: SessionId })
export type SessionIdentity = typeof SessionIdentity.Type

export const SessionSnapshot = Schema.Union(
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("pending"),
    sequence: Schema.Literal(0),
  }),
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("registered"),
    sequence: Sequence,
  }),
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("assigned"),
    sequence: Sequence,
    jobId: JobId,
  }),
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("executing"),
    sequence: Sequence,
    jobId: JobId,
    attemptId: AttemptId,
  }),
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("closed", "owner-lost"),
    sequence: Sequence,
    terminalEventId: SessionEventId,
  }),
)
export type SessionSnapshot = typeof SessionSnapshot.Type

export const SessionEventReceipt = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("recorded"), event: SessionEvent }),
)
export type SessionEventReceipt = typeof SessionEventReceipt.Type

export class SessionEventError extends Data.TaggedError("SessionEventError")<{
  readonly code:
    | "malformed"
    | "stale-session"
    | "receipt-conflict"
    | "out-of-order"
    | "invalid-transition"
    | "foreign-attempt"
}> {}

export type SessionEventDecision =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "appended"
      readonly snapshot: SessionSnapshot
      readonly event: SessionEvent
    }

// Planned acceptance entry point: pure decision over the current snapshot,
// session ownership, prior event receipt, and the incoming event. It grants
// no claim, dispatch, or persistence authority; the store applies it in one
// transaction.
export type DecideSessionEvent = (
  snapshot: SessionSnapshot,
  ownership: SessionIdentity,
  receipt: SessionEventReceipt,
  event: SessionEvent,
) => import("effect").Effect.Effect<SessionEventDecision, SessionEventError>
