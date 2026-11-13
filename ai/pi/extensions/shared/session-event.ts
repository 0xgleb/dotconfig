import { Data, Effect, Schema } from "effect"
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
    sequence: Schema.Literal(1),
  }),
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("assigned"),
    sequence: Sequence.pipe(Schema.greaterThanOrEqualTo(2)),
    jobId: JobId,
  }),
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("executing"),
    sequence: Sequence.pipe(Schema.greaterThanOrEqualTo(3)),
    jobId: JobId,
    attemptId: AttemptId,
  }),
  Schema.Struct({
    sessionId: SessionId,
    status: Schema.Literal("closed", "owner-lost"),
    sequence: Sequence.pipe(Schema.greaterThanOrEqualTo(2)),
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

// Pure decision over the current snapshot,
// session ownership, prior event receipt, and the incoming event. It grants
// no claim, dispatch, or persistence authority; the store applies it in one
// transaction.
export type DecideSessionEvent = (
  snapshot: SessionSnapshot,
  ownership: SessionIdentity,
  receipt: SessionEventReceipt,
  event: SessionEvent,
) => Effect.Effect<SessionEventDecision, SessionEventError>

const failure = (code: SessionEventError["code"]) =>
  Effect.fail(new SessionEventError({ code }))

const decodeBoundary = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new SessionEventError({ code: "malformed" })),
  )

const sameEvent = Schema.equivalence(SessionEvent)
const sameSnapshot = Schema.equivalence(SessionSnapshot)

const snapshotAfter = (
  event: SessionEvent,
): Effect.Effect<SessionSnapshot, SessionEventError> => {
  const fields = { sessionId: event.sessionId, sequence: event.sequence }
  switch (event.kind) {
    case "registered":
      return decodeBoundary(SessionSnapshot, {
        ...fields,
        status: "registered",
      })
    case "assigned":
    case "attempt-released":
      return decodeBoundary(SessionSnapshot, {
        ...fields,
        status: "assigned",
        jobId: event.jobId,
      })
    case "attempt-started":
      return decodeBoundary(SessionSnapshot, {
        ...fields,
        status: "executing",
        jobId: event.jobId,
        attemptId: event.attemptId,
      })
    case "closed":
    case "owner-lost":
      return decodeBoundary(SessionSnapshot, {
        ...fields,
        status: event.kind,
        terminalEventId: event.eventId,
      })
  }
}

const permitsTransition = (
  current: SessionSnapshot,
  incoming: SessionEvent,
): boolean => {
  if (current.status === "closed" || current.status === "owner-lost")
    return false
  if (current.status === "pending") return incoming.kind === "registered"
  switch (incoming.kind) {
    case "registered":
      return false
    case "assigned":
      return current.status === "registered" || current.status === "assigned"
    case "attempt-started":
      return current.status === "assigned"
    case "attempt-released":
      return current.status === "executing"
    case "closed":
    case "owner-lost":
      return true
  }
}

export const decideSessionEvent: DecideSessionEvent = (
  snapshot,
  ownership,
  receipt,
  event,
) =>
  Effect.gen(function* () {
    const current = yield* decodeBoundary(SessionSnapshot, snapshot)
    const active = yield* decodeBoundary(SessionIdentity, ownership)
    const prior = yield* decodeBoundary(SessionEventReceipt, receipt)
    const incoming = yield* decodeBoundary(SessionEvent, event)
    if (
      current.sessionId !== active.sessionId ||
      incoming.sessionId !== active.sessionId
    )
      return yield* failure("stale-session")

    if (prior.kind === "recorded") {
      const projected = yield* snapshotAfter(incoming).pipe(
        Effect.mapError(
          () => new SessionEventError({ code: "receipt-conflict" }),
        ),
      )
      if (
        !sameEvent(prior.event, incoming) ||
        incoming.sequence > current.sequence ||
        (incoming.sequence === current.sequence &&
          !sameSnapshot(current, projected)) ||
        ((incoming.kind === "closed" || incoming.kind === "owner-lost") &&
          incoming.sequence !== current.sequence) ||
        ((current.status === "closed" || current.status === "owner-lost") &&
          current.terminalEventId === incoming.eventId &&
          !sameSnapshot(current, projected))
      )
        return yield* failure("receipt-conflict")
      return { kind: "duplicate" }
    }

    if (
      current.sequence === Number.MAX_SAFE_INTEGER ||
      incoming.sequence !== current.sequence + 1
    )
      return yield* failure("out-of-order")
    if (
      (incoming.kind === "attempt-started" ||
        incoming.kind === "attempt-released") &&
      "jobId" in current &&
      (current.jobId !== incoming.jobId ||
        (incoming.kind === "attempt-released" &&
          "attemptId" in current &&
          current.attemptId !== incoming.attemptId))
    )
      return yield* failure("foreign-attempt")
    if (!permitsTransition(current, incoming))
      return yield* failure("invalid-transition")

    return {
      kind: "appended",
      snapshot: yield* snapshotAfter(incoming),
      event: incoming,
    }
  })
