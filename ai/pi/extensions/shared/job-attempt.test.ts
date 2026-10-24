import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Schema } from "effect"
import * as contract from "./job-attempt.ts"
import type { AttemptEventError, EventReceipt } from "./job-attempt.ts"

const { AttemptEvent, AttemptIdentity, AttemptSnapshot } = contract
const decodeAttemptEvent: typeof contract.decodeAttemptEvent = (...args) => {
  assert.equal(
    typeof contract.decodeAttemptEvent,
    "function",
    "event decoder is exported",
  )
  return contract.decodeAttemptEvent(...args)
}
const decideAttemptEvent: typeof contract.decideAttemptEvent = (...args) => {
  assert.equal(
    typeof contract.decideAttemptEvent,
    "function",
    "event acceptance is exported",
  )
  return contract.decideAttemptEvent(...args)
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const ownership = Schema.decodeUnknownSync(AttemptIdentity)({
  jobId: uuid(1),
  attemptId: uuid(2),
  fence: uuid(3),
})
const snapshot = (changes: Readonly<Record<string, unknown>> = {}) =>
  Schema.decodeUnknownSync(AttemptSnapshot)({
    ...ownership,
    status: "running",
    sequence: 2,
    ...changes,
  })
const event = (
  sequence: number,
  changes: Readonly<Record<string, unknown>> = {},
) =>
  Schema.decodeUnknownSync(AttemptEvent)({
    ...ownership,
    version: 1,
    kind: "running",
    eventId: uuid(100 + sequence),
    sequence,
    occurredAt: sequence * 100,
    ...changes,
  })
const absent: EventReceipt = { kind: "absent" }
const unknownUsage = { kind: "unknown" }
const success = () =>
  event(3, {
    kind: "succeeded",
    result: { attemptId: ownership.attemptId, outputId: uuid(10) },
    usage: unknownUsage,
  })
const expectError = async <A>(
  effect: Effect.Effect<A, AttemptEventError>,
  code: AttemptEventError["code"],
) => {
  const result = await Effect.runPromise(Effect.either(effect))
  assert.equal(result._tag, "Left")
  if (result._tag === "Left") assert.equal(result.left.code, code)
}

test("records a terminal event and retains its durable event identity", async () => {
  const terminal = success()
  const result = await Effect.runPromise(
    decideAttemptEvent(snapshot(), ownership, absent, terminal),
  )
  assert.equal(result.kind, "appended")
  if (result.kind === "appended") {
    assert.equal(result.snapshot.status, "succeeded")
    assert.equal(result.snapshot.sequence, 3)
    assert.equal(
      "terminalEventId" in result.snapshot && result.snapshot.terminalEventId,
      terminal.eventId,
    )
    assert.deepEqual(result.event, terminal)
  }
})

test("an identical terminal receipt is idempotent; changed payload is not", async () => {
  const terminal = success()
  const finished = snapshot({
    status: "succeeded",
    sequence: 3,
    terminalEventId: terminal.eventId,
  })
  const receipt: EventReceipt = { kind: "recorded", event: terminal }
  assert.deepEqual(
    await Effect.runPromise(
      decideAttemptEvent(finished, ownership, receipt, terminal),
    ),
    { kind: "duplicate" },
  )
  await expectError(
    decideAttemptEvent(finished, ownership, receipt, {
      ...terminal,
      occurredAt: 999,
    }),
    "receipt-conflict",
  )
})

test("rejects an old attempt or fence without replacing the current projection", async () => {
  const current = snapshot()
  await expectError(
    decideAttemptEvent(
      current,
      ownership,
      absent,
      event(3, {
        kind: "output",
        attemptId: uuid(20),
        output: { attemptId: uuid(20), outputId: uuid(10) },
      }),
    ),
    "stale-attempt",
  )
  await expectError(
    decideAttemptEvent(
      current,
      {
        ...ownership,
        fence: Schema.decodeUnknownSync(AttemptIdentity)({
          ...ownership,
          fence: uuid(30),
        }).fence,
      },
      absent,
      success(),
    ),
    "stale-fence",
  )
  assert.equal(current.sequence, 2)
  assert.equal(current.status, "running")
})

test("nonterminal receipts are idempotent only when consistent with the snapshot", async () => {
  const started = event(2)
  const receipt: EventReceipt = { kind: "recorded", event: started }
  assert.deepEqual(
    await Effect.runPromise(
      decideAttemptEvent(snapshot(), ownership, receipt, started),
    ),
    { kind: "duplicate" },
  )
  const terminal = success()
  assert.deepEqual(
    await Effect.runPromise(
      decideAttemptEvent(
        snapshot({
          status: "succeeded",
          sequence: 3,
          terminalEventId: terminal.eventId,
        }),
        ownership,
        receipt,
        started,
      ),
    ),
    { kind: "duplicate" },
  )
  await expectError(
    decideAttemptEvent(
      snapshot({ status: "stopping" }),
      ownership,
      receipt,
      started,
    ),
    "receipt-conflict",
  )
  await expectError(
    decideAttemptEvent(
      snapshot({ status: "pending", sequence: 1 }),
      ownership,
      receipt,
      started,
    ),
    "receipt-conflict",
  )
})

test("rejects missing or reordered sequence numbers", async () => {
  await expectError(
    decideAttemptEvent(
      snapshot(),
      ownership,
      absent,
      event(4, { kind: "stopping", reason: "user" }),
    ),
    "out-of-order",
  )
  await expectError(
    decideAttemptEvent(snapshot(), ownership, absent, event(2)),
    "out-of-order",
  )
})

test("outputs are attempt-owned and do not mark work complete", async () => {
  const output = event(3, {
    kind: "output",
    output: { attemptId: ownership.attemptId, outputId: uuid(10) },
  })
  const result = await Effect.runPromise(
    decideAttemptEvent(snapshot(), ownership, absent, output),
  )
  assert.equal(result.kind, "appended")
  if (result.kind === "appended") {
    assert.equal(result.snapshot.status, "running")
    assert.equal(result.snapshot.sequence, 3)
  }
  await expectError(
    decideAttemptEvent(
      snapshot(),
      ownership,
      absent,
      event(3, {
        kind: "output",
        output: { attemptId: uuid(20), outputId: uuid(10) },
      }),
    ),
    "foreign-output",
  )
  await expectError(
    decideAttemptEvent(
      snapshot(),
      ownership,
      absent,
      event(3, {
        kind: "succeeded",
        result: { attemptId: uuid(20), outputId: uuid(10) },
        usage: unknownUsage,
      }),
    ),
    "foreign-output",
  )
})

test("stopping plus an unconfirmed exit remains interrupted, not resumable", async () => {
  const interrupted = event(4, {
    kind: "interrupted",
    reason: "unconfirmed-exit",
    usage: unknownUsage,
  })
  const result = await Effect.runPromise(
    decideAttemptEvent(
      snapshot({ status: "stopping", sequence: 3 }),
      ownership,
      absent,
      interrupted,
    ),
  )
  assert.equal(result.kind, "appended")
  if (result.kind === "appended") {
    assert.equal(result.snapshot.status, "interrupted")
    await expectError(
      decideAttemptEvent(result.snapshot, ownership, absent, event(5)),
      "invalid-transition",
    )
  }
})

test("the first event must register pending before execution starts", async () => {
  const initial = snapshot({ status: "pending", sequence: 0 })
  await expectError(
    decideAttemptEvent(initial, ownership, absent, event(1)),
    "invalid-transition",
  )
  const pending = event(1, { kind: "pending" })
  const result = await Effect.runPromise(
    decideAttemptEvent(initial, ownership, absent, pending),
  )
  assert.equal(result.kind, "appended")
  if (result.kind === "appended") assert.equal(result.snapshot.sequence, 1)
})

for (const { status, sequence } of [
  { status: "pending", sequence: 2 },
  { status: "running", sequence: 1 },
  { status: "stopping", sequence: 1 },
  { status: "succeeded", sequence: 2 },
  { status: "failed", sequence: 1 },
  { status: "cancelled", sequence: 1 },
  { status: "interrupted", sequence: 1 },
]) {
  test(`rejects impossible persisted snapshot ${status}:${sequence}`, async () => {
    const input = {
      ...ownership,
      status,
      sequence,
      ...(["succeeded", "failed", "cancelled", "interrupted"].includes(status)
        ? { terminalEventId: uuid(103) }
        : {}),
    }
    const result = await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(AttemptSnapshot)(input)),
    )
    assert.equal(result._tag, "Left")
  })
}

test("rejects alternate spellings of durable UUID identities", async () => {
  await expectError(
    decodeAttemptEvent({
      ...success(),
      eventId: "AAAAAAAA-0000-4000-8000-000000000001",
    }),
    "malformed",
  )
})

test("malformed, unknown-version and unbounded counters fail at decoding", async () => {
  for (const input of [
    { ...success(), version: 2 },
    { ...success(), sequence: 0 },
    { ...success(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...success(), unexpected: true },
    { ...success(), eventId: "pid:42" },
    { ...success(), usage: { kind: "observed", tokens: -1 } },
  ])
    await expectError(decodeAttemptEvent(input), "malformed")
})
