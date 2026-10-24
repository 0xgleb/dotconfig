import { Data, Effect, Schema } from "effect"

const CanonicalUuid = Schema.UUID.pipe(Schema.pattern(/^[0-9a-f-]+$/))
export const JobId = CanonicalUuid.pipe(Schema.brand("JobId"))
export const AttemptId = CanonicalUuid.pipe(Schema.brand("AttemptId"))
export const AttemptEventId = CanonicalUuid.pipe(Schema.brand("AttemptEventId"))
export const AttemptFence = CanonicalUuid.pipe(Schema.brand("AttemptFence"))
export const AttemptOutputId = CanonicalUuid.pipe(
  Schema.brand("AttemptOutputId"),
)

const Counter = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Sequence = Counter.pipe(Schema.greaterThanOrEqualTo(1))
const identityFields = {
  jobId: JobId,
  attemptId: AttemptId,
  fence: AttemptFence,
}
export const AttemptIdentity = Schema.Struct(identityFields)
export type AttemptIdentity = typeof AttemptIdentity.Type

const OutputReference = Schema.Struct({
  attemptId: AttemptId,
  outputId: AttemptOutputId,
})
const Usage = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("observed"), tokens: Counter }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
)
const StopReason = Schema.Literal("user", "session-closed", "budget")
const FailureReason = Schema.Literal("blocked", "execution", "timed-out")
const InterruptionReason = Schema.Literal("unconfirmed-exit", "owner-lost")
const eventFields = {
  ...identityFields,
  version: Schema.Literal(1),
  eventId: AttemptEventId,
  sequence: Sequence,
  occurredAt: Counter,
}
export const AttemptEvent = Schema.Union(
  Schema.Struct({ ...eventFields, kind: Schema.Literal("pending", "running") }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("output"),
    output: OutputReference,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("stopping"),
    reason: StopReason,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("succeeded"),
    result: OutputReference,
    usage: Usage,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("failed"),
    reason: FailureReason,
    usage: Usage,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("cancelled"),
    reason: StopReason,
    usage: Usage,
  }),
  Schema.Struct({
    ...eventFields,
    kind: Schema.Literal("interrupted"),
    reason: InterruptionReason,
    usage: Usage,
  }),
)
export type AttemptEvent = typeof AttemptEvent.Type

export const AttemptSnapshot = Schema.Union(
  Schema.Struct({
    ...identityFields,
    status: Schema.Literal("pending"),
    sequence: Schema.Literal(0, 1),
  }),
  Schema.Struct({
    ...identityFields,
    status: Schema.Literal("running", "stopping"),
    sequence: Counter.pipe(Schema.greaterThanOrEqualTo(2)),
  }),
  Schema.Struct({
    ...identityFields,
    status: Schema.Literal("succeeded"),
    sequence: Counter.pipe(Schema.greaterThanOrEqualTo(3)),
    terminalEventId: AttemptEventId,
  }),
  Schema.Struct({
    ...identityFields,
    status: Schema.Literal("failed", "cancelled", "interrupted"),
    sequence: Counter.pipe(Schema.greaterThanOrEqualTo(2)),
    terminalEventId: AttemptEventId,
  }),
)
export type AttemptSnapshot = typeof AttemptSnapshot.Type
export const EventReceipt = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("recorded"), event: AttemptEvent }),
)
export type EventReceipt = typeof EventReceipt.Type

export class AttemptEventError extends Data.TaggedError("AttemptEventError")<{
  readonly code:
    | "malformed"
    | "stale-attempt"
    | "stale-fence"
    | "receipt-conflict"
    | "out-of-order"
    | "invalid-transition"
    | "foreign-output"
}> {}
export type AttemptEventDecision =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "appended"
      readonly snapshot: AttemptSnapshot
      readonly event: AttemptEvent
    }

const failure = (code: AttemptEventError["code"]) =>
  Effect.fail(new AttemptEventError({ code }))

const decodeBoundary = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new AttemptEventError({ code: "malformed" })),
  )

export const decodeAttemptEvent = (
  input: unknown,
): Effect.Effect<AttemptEvent, AttemptEventError> =>
  decodeBoundary(AttemptEvent, input)

const sameEvent = Schema.equivalence(AttemptEvent)
type TerminalStatus = "succeeded" | "failed" | "cancelled" | "interrupted"
const isTerminal = (kind: AttemptEvent["kind"]): kind is TerminalStatus =>
  kind === "succeeded" ||
  kind === "failed" ||
  kind === "cancelled" ||
  kind === "interrupted"

const permitsTransition = (
  snapshot: AttemptSnapshot,
  event: AttemptEvent,
): boolean => {
  if (snapshot.sequence === 0) return event.kind === "pending"
  if (event.kind === "pending" || isTerminal(snapshot.status)) return false
  if (snapshot.status === "pending")
    return event.kind !== "output" && event.kind !== "succeeded"
  if (snapshot.status === "running") return event.kind !== "running"
  return (
    event.kind === "output" ||
    event.kind === "cancelled" ||
    event.kind === "failed" ||
    event.kind === "interrupted"
  )
}

// The persistence owner must read the active attempt/fence and event-ID receipt,
// then apply this decision in the SAME transaction. This function grants no
// claim or dispatch authority and does not migrate legacy workflow state.
export const decideAttemptEvent = (
  snapshot: AttemptSnapshot,
  ownership: AttemptIdentity,
  receipt: EventReceipt,
  event: AttemptEvent,
): Effect.Effect<AttemptEventDecision, AttemptEventError> =>
  Effect.gen(function* () {
    const current = yield* decodeBoundary(AttemptSnapshot, snapshot)
    const active = yield* decodeBoundary(AttemptIdentity, ownership)
    const prior = yield* decodeBoundary(EventReceipt, receipt)
    const incoming = yield* decodeAttemptEvent(event)
    if (
      current.jobId !== active.jobId ||
      current.attemptId !== active.attemptId ||
      incoming.jobId !== active.jobId ||
      incoming.attemptId !== active.attemptId
    )
      return yield* failure("stale-attempt")
    if (current.fence !== active.fence || incoming.fence !== active.fence)
      return yield* failure("stale-fence")
    if (
      (incoming.kind === "output" &&
        incoming.output.attemptId !== incoming.attemptId) ||
      (incoming.kind === "succeeded" &&
        incoming.result.attemptId !== incoming.attemptId)
    )
      return yield* failure("foreign-output")

    if (prior.kind === "recorded") {
      if (
        !sameEvent(prior.event, incoming) ||
        incoming.sequence > current.sequence
      )
        return yield* failure("receipt-conflict")
      if (isTerminal(incoming.kind)) {
        if (
          current.sequence !== incoming.sequence ||
          current.status !== incoming.kind ||
          !("terminalEventId" in current) ||
          current.terminalEventId !== incoming.eventId
        )
          return yield* failure("receipt-conflict")
      } else if (incoming.sequence === current.sequence) {
        if (
          incoming.kind === "output"
            ? current.status !== "running" && current.status !== "stopping"
            : current.status !== incoming.kind
        )
          return yield* failure("receipt-conflict")
      }
      return { kind: "duplicate" }
    }
    if (
      current.sequence === Number.MAX_SAFE_INTEGER ||
      incoming.sequence !== current.sequence + 1
    )
      return yield* failure("out-of-order")
    if (!permitsTransition(current, incoming))
      return yield* failure("invalid-transition")
    const next = yield* decodeBoundary(AttemptSnapshot, {
      ...active,
      status: incoming.kind === "output" ? current.status : incoming.kind,
      sequence: incoming.sequence,
      ...(isTerminal(incoming.kind)
        ? { terminalEventId: incoming.eventId }
        : {}),
    })
    return { kind: "appended", snapshot: next, event: incoming }
  })
