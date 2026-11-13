import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Schema } from "effect"
import * as contract from "./session-event.ts"
import {
  SessionEvent,
  SessionIdentity,
  SessionSnapshot,
} from "./session-event.ts"

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const registered = () => ({
  version: 1,
  sessionId: uuid(1),
  eventId: uuid(101),
  sequence: 1,
  occurredAt: 100,
  kind: "registered" as const,
  role: "worker" as const,
  capabilities: {
    model: "openai-codex/gpt-6.1-sol",
    reasoning: "medium" as const,
    tools: ["read", "grep", "workflow_audit"],
  },
})

const assigned = () => ({
  version: 1,
  sessionId: uuid(1),
  eventId: uuid(102),
  sequence: 2,
  occurredAt: 200,
  kind: "assigned" as const,
  jobId: uuid(10),
})

const attemptStarted = () => ({
  version: 1,
  sessionId: uuid(1),
  eventId: uuid(103),
  sequence: 3,
  occurredAt: 300,
  kind: "attempt-started" as const,
  jobId: uuid(10),
  attemptId: uuid(11),
})

const ownerLost = () => ({
  version: 1,
  sessionId: uuid(1),
  eventId: uuid(104),
  sequence: 4,
  occurredAt: 400,
  kind: "owner-lost" as const,
})

const decodeSync = (input: unknown) =>
  Schema.decodeUnknownSync(SessionEvent, { onExcessProperty: "error" })(input)

const expectRejected = (input: unknown) => {
  assert.throws(() => decodeSync(input))
}

test("accepts every declared event kind as the positive control", () => {
  for (const event of [registered(), assigned(), attemptStarted(), ownerLost()])
    assert.equal(decodeSync(event).kind, event.kind)
})

test("session identity must be a canonical uuid, never a pid composite", () => {
  expectRejected({ ...registered(), sessionId: "not-a-uuid" })
  expectRejected({
    ...registered(),
    sessionId: "AAAAAAAA-0000-4000-8000-000000000001",
  })
  expectRejected({
    ...registered(),
    sessionId: `${uuid(1)}:pid:4213`,
  })
})

test("event identities share the session identity constraints", () => {
  expectRejected({ ...registered(), eventId: "session:1" })
  expectRejected({ ...assigned(), eventId: `${uuid(102)}:pid:1` })
})

test("sequence and occurrence counters must be ordered safe integers", () => {
  expectRejected({ ...registered(), sequence: 0 })
  expectRejected({ ...registered(), sequence: 1.5 })
  expectRejected({ ...registered(), sequence: -1 })
  expectRejected({ ...registered(), sequence: Number.MAX_SAFE_INTEGER + 1 })
  expectRejected({ ...registered(), occurredAt: -1 })
  expectRejected({ ...registered(), occurredAt: Number.MAX_SAFE_INTEGER + 1 })
})

test("declared capabilities must be resolved and bounded", () => {
  const base = registered()
  expectRejected({
    ...base,
    capabilities: { ...base.capabilities, model: "" },
  })
  expectRejected({
    ...base,
    capabilities: {
      ...base.capabilities,
      reasoning: "inherit" as unknown as typeof base.capabilities.reasoning,
    },
  })
  expectRejected({
    ...base,
    capabilities: { ...base.capabilities, tools: [] },
  })
  expectRejected({
    ...base,
    capabilities: { ...base.capabilities, tools: ["read", "read"] },
  })
  expectRejected({
    ...base,
    capabilities: {
      ...base.capabilities,
      tools: Array.from({ length: 17 }, () => "read"),
    },
  })
  expectRejected({
    ...base,
    capabilities: { ...base.capabilities, tools: ["a".repeat(65)] },
  })
})

test("assignment linkage must reference committed job and attempt identities", () => {
  expectRejected({ ...assigned(), jobId: "job-1" })
  expectRejected({
    ...attemptStarted(),
    attemptId: `${uuid(11)}:pid:7`,
  })
})

test("terminal session events carry no execution fields", () => {
  assert.throws(() => decodeSync({ ...ownerLost(), attemptId: uuid(11) }))
})

const ownership = Schema.decodeUnknownSync(SessionIdentity)({
  sessionId: uuid(1),
})
const snapshot = (changes: Readonly<Record<string, unknown>> = {}) =>
  Schema.decodeUnknownSync(SessionSnapshot)({
    sessionId: uuid(1),
    status: "registered",
    sequence: 1,
    ...changes,
  })
const eventAt = (sequence: number, fields: Readonly<Record<string, unknown>>) =>
  decodeSync({
    version: 1,
    sessionId: uuid(1),
    eventId: uuid(200 + sequence),
    sequence,
    occurredAt: sequence * 100,
    ...fields,
  })
const registration = () =>
  eventAt(1, {
    kind: "registered",
    role: "worker",
    capabilities: registered().capabilities,
  })
const absent = { kind: "absent" as const }

const expectSessionError = async (args: readonly unknown[], code: string) => {
  const result = await Effect.runPromise(
    Effect.either(
      Reflect.apply(contract.decideSessionEvent, undefined, args) as ReturnType<
        import("./session-event.ts").DecideSessionEvent
      >,
    ),
  )
  assert.equal(result._tag, "Left")
  if (result._tag === "Left") assert.equal(result.left.code, code)
}

test("exposes session acceptance as a callable export", () => {
  assert.equal(
    typeof contract.decideSessionEvent,
    "function",
    "decideSessionEvent must be exported as a function",
  )
})

test("registers a pending session and keeps its assignment linkage", async () => {
  const pending = snapshot({ status: "pending", sequence: 0 })
  const registeredResult = await Effect.runPromise(
    contract.decideSessionEvent(pending, ownership, absent, registration()),
  )
  assert.ok(registeredResult.kind === "appended")
  assert.deepEqual(registeredResult.snapshot, {
    sessionId: pending.sessionId,
    status: "registered",
    sequence: 1,
  })

  const assignment = eventAt(2, { kind: "assigned", jobId: uuid(10) })
  const assignedResult = await Effect.runPromise(
    contract.decideSessionEvent(
      registeredResult.snapshot,
      ownership,
      absent,
      assignment,
    ),
  )
  assert.ok(assignedResult.kind === "appended")
  assert.deepEqual(assignedResult.snapshot, {
    sessionId: pending.sessionId,
    status: "assigned",
    sequence: 2,
    jobId: uuid(10),
  })
})

test("executes an assigned attempt and releases back to assigned", async () => {
  const started = eventAt(3, {
    kind: "attempt-started",
    jobId: uuid(10),
    attemptId: uuid(11),
  })
  const startedResult = await Effect.runPromise(
    contract.decideSessionEvent(
      snapshot({ status: "assigned", sequence: 2, jobId: uuid(10) }),
      ownership,
      absent,
      started,
    ),
  )
  assert.ok(startedResult.kind === "appended")
  assert.deepEqual(startedResult.snapshot, {
    sessionId: ownership.sessionId,
    status: "executing",
    sequence: 3,
    jobId: uuid(10),
    attemptId: uuid(11),
  })

  const released = eventAt(4, {
    kind: "attempt-released",
    jobId: uuid(10),
    attemptId: uuid(11),
  })
  const releasedResult = await Effect.runPromise(
    contract.decideSessionEvent(
      startedResult.snapshot,
      ownership,
      absent,
      released,
    ),
  )
  assert.ok(releasedResult.kind === "appended")
  assert.deepEqual(releasedResult.snapshot, {
    sessionId: ownership.sessionId,
    status: "assigned",
    sequence: 4,
    jobId: uuid(10),
  })
})

test("a terminal receipt is idempotent and a changed payload conflicts", async () => {
  const closed = eventAt(2, { kind: "closed" })
  const finished = snapshot({
    status: "closed",
    sequence: 2,
    terminalEventId: closed.eventId,
  })
  assert.deepEqual(
    await Effect.runPromise(
      contract.decideSessionEvent(
        finished,
        ownership,
        { kind: "recorded", event: closed },
        closed,
      ),
    ),
    { kind: "duplicate" },
  )
  await expectSessionError(
    [finished, ownership, absent, closed],
    "out-of-order",
  )
  await expectSessionError(
    [
      finished,
      ownership,
      absent,
      { ...closed, occurredAt: closed.occurredAt + 1 },
    ],
    "out-of-order",
  )
})

test("rejects a foreign session or attempt without replacing state", async () => {
  await expectSessionError(
    [
      snapshot(),
      ownership,
      absent,
      eventAt(2, {
        kind: "assigned",
        sessionId: uuid(99),
        jobId: uuid(10),
      }),
    ],
    "stale-session",
  )
  await expectSessionError(
    [
      snapshot({ status: "assigned", sequence: 2, jobId: uuid(10) }),
      ownership,
      absent,
      eventAt(3, {
        kind: "attempt-started",
        jobId: uuid(20),
        attemptId: uuid(11),
      }),
    ],
    "foreign-attempt",
  )
})

test("rejects missing or reordered sequence numbers", async () => {
  await expectSessionError(
    [
      snapshot(),
      ownership,
      absent,
      eventAt(3, { kind: "assigned", jobId: uuid(40) }),
    ],
    "out-of-order",
  )
  await expectSessionError(
    [snapshot(), ownership, absent, registration()],
    "out-of-order",
  )
})

test("rejects impossible transitions for the session lifecycle", async () => {
  await expectSessionError(
    [
      snapshot({ status: "pending", sequence: 0 }),
      ownership,
      absent,
      eventAt(1, { kind: "assigned", jobId: uuid(10) }),
    ],
    "invalid-transition",
  )
  await expectSessionError(
    [
      snapshot(),
      ownership,
      absent,
      eventAt(2, {
        kind: "attempt-started",
        jobId: uuid(10),
        attemptId: uuid(11),
      }),
    ],
    "invalid-transition",
  )
  await expectSessionError(
    [
      snapshot({
        status: "closed",
        sequence: 2,
        terminalEventId: uuid(202),
      }),
      ownership,
      absent,
      eventAt(3, { kind: "assigned", jobId: uuid(30) }),
    ],
    "invalid-transition",
  )
})

test("recorded receipts retain exact payload and current projection consistency", async () => {
  const event = registration()
  assert.deepEqual(
    await Effect.runPromise(
      contract.decideSessionEvent(
        snapshot(),
        ownership,
        { kind: "recorded", event },
        event,
      ),
    ),
    { kind: "duplicate" },
  )
  await expectSessionError(
    [
      snapshot(),
      ownership,
      { kind: "recorded", event },
      { ...event, occurredAt: event.occurredAt + 1 },
    ],
    "receipt-conflict",
  )
  await expectSessionError(
    [
      snapshot({
        status: "closed",
        sequence: 2,
        terminalEventId: event.eventId,
      }),
      ownership,
      { kind: "recorded", event },
      event,
    ],
    "receipt-conflict",
  )
  const assignment = eventAt(2, { kind: "assigned", jobId: uuid(10) })
  await expectSessionError(
    [
      snapshot(),
      ownership,
      { kind: "recorded", event: assignment },
      assignment,
    ],
    "receipt-conflict",
  )
  await expectSessionError(
    [
      snapshot({ status: "assigned", sequence: 2, jobId: uuid(20) }),
      ownership,
      { kind: "recorded", event: assignment },
      assignment,
    ],
    "receipt-conflict",
  )
})

test("terminal receipt payload changes cannot rewrite the terminal identity", async () => {
  const event = eventAt(2, { kind: "closed" })
  const current = snapshot({
    status: "closed",
    sequence: 2,
    terminalEventId: event.eventId,
  })
  await expectSessionError(
    [
      current,
      ownership,
      { kind: "recorded", event },
      { ...event, occurredAt: event.occurredAt + 1 },
    ],
    "receipt-conflict",
  )
  await expectSessionError(
    [
      current,
      ownership,
      { kind: "recorded", event },
      { ...event, kind: "owner-lost" },
    ],
    "receipt-conflict",
  )
})

test("terminal events close registered, assigned and executing sessions without mutating inputs", async () => {
  for (const current of [
    snapshot(),
    snapshot({ status: "assigned", sequence: 2, jobId: uuid(10) }),
    snapshot({
      status: "executing",
      sequence: 3,
      jobId: uuid(10),
      attemptId: uuid(11),
    }),
  ]) {
    for (const kind of ["closed", "owner-lost"] as const) {
      const before = structuredClone(current)
      const event = eventAt(current.sequence + 1, { kind })
      const result = await Effect.runPromise(
        contract.decideSessionEvent(current, ownership, absent, event),
      )
      assert.deepEqual(result, {
        kind: "appended",
        snapshot: {
          sessionId: current.sessionId,
          status: kind,
          sequence: event.sequence,
          terminalEventId: event.eventId,
        },
        event,
      })
      assert.deepEqual(current, before)
    }
  }
})

test("released assignments can be replaced without admitting a foreign active attempt", async () => {
  const current = snapshot({ status: "assigned", sequence: 4, jobId: uuid(10) })
  const assignment = eventAt(5, { kind: "assigned", jobId: uuid(20) })
  const result = await Effect.runPromise(
    contract.decideSessionEvent(current, ownership, absent, assignment),
  )
  assert.deepEqual(result, {
    kind: "appended",
    snapshot: {
      sessionId: current.sessionId,
      status: "assigned",
      sequence: 5,
      jobId: uuid(20),
    },
    event: assignment,
  })
  await expectSessionError(
    [
      snapshot({
        status: "executing",
        sequence: 3,
        jobId: uuid(10),
        attemptId: uuid(11),
      }),
      ownership,
      absent,
      eventAt(4, {
        kind: "attempt-released",
        jobId: uuid(10),
        attemptId: uuid(12),
      }),
    ],
    "foreign-attempt",
  )
})

test("snapshot boundaries reject state and sequence combinations unreachable through acceptance", async () => {
  for (const fields of [
    { status: "pending", sequence: 1 },
    { status: "registered", sequence: 5 },
    { status: "assigned", sequence: 1, jobId: uuid(10) },
    { status: "executing", sequence: 2, jobId: uuid(10), attemptId: uuid(11) },
    { status: "closed", sequence: 1, terminalEventId: uuid(201) },
    { status: "owner-lost", sequence: 1, terminalEventId: uuid(201) },
  ]) {
    const current = { sessionId: ownership.sessionId, ...fields }
    assert.equal(
      Schema.decodeUnknownEither(SessionSnapshot)(current)._tag,
      "Left",
    )
    await expectSessionError(
      [
        current,
        ownership,
        absent,
        eventAt(fields.sequence + 1, { kind: "assigned", jobId: uuid(10) }),
      ],
      "malformed",
    )
  }
})

test("all acceptance boundaries reject malformed inputs and stale ownership", async () => {
  const event = eventAt(2, { kind: "assigned", jobId: uuid(10) })
  for (const args of [
    [null, ownership, absent, event],
    [snapshot(), null, absent, event],
    [snapshot(), ownership, { kind: "recorded" }, event],
    [snapshot(), ownership, absent, { ...event, sequence: 1.5 }],
  ])
    await expectSessionError(args, "malformed")
  await expectSessionError(
    [snapshot(), { sessionId: uuid(99) }, absent, event],
    "stale-session",
  )
  await expectSessionError(
    [
      snapshot({
        status: "assigned",
        sequence: Number.MAX_SAFE_INTEGER,
        jobId: uuid(10),
      }),
      ownership,
      absent,
      event,
    ],
    "out-of-order",
  )
})
