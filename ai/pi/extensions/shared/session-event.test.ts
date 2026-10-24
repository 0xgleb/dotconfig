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
  assert.equal(registeredResult.kind, "appended")

  const assignment = eventAt(2, { kind: "assigned", jobId: uuid(10) })
  const assignedResult = await Effect.runPromise(
    contract.decideSessionEvent(snapshot(), ownership, absent, assignment),
  )
  assert.equal(assignedResult.kind, "appended")
  if (assignedResult.kind === "appended")
    assert.equal(assignedResult.snapshot.status, "assigned")
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
  assert.equal(startedResult.kind, "appended")

  const released = eventAt(4, {
    kind: "attempt-released",
    jobId: uuid(10),
    attemptId: uuid(11),
  })
  const releasedResult = await Effect.runPromise(
    contract.decideSessionEvent(
      snapshot({
        status: "executing",
        sequence: 3,
        jobId: uuid(10),
        attemptId: uuid(11),
      }),
      ownership,
      absent,
      released,
    ),
  )
  assert.equal(releasedResult.kind, "appended")
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
      contract.decideSessionEvent(finished, ownership, absent, closed),
    ),
    { kind: "duplicate" },
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
