import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { AttemptEventError, decideAttemptEvent } from "./job-attempt.ts"

const identity = {
  jobId: "00000000-0000-4000-8000-000000000001",
  attemptId: "00000000-0000-4000-8000-000000000002",
  fence: "00000000-0000-4000-8000-000000000003",
}
const snapshot = { ...identity, status: "running", sequence: 2 }
const absent = { kind: "absent" }
const terminal = {
  ...identity,
  version: 1,
  kind: "succeeded",
  eventId: "00000000-0000-4000-8000-000000000103",
  sequence: 3,
  occurredAt: 300,
  result: {
    attemptId: identity.attemptId,
    outputId: "00000000-0000-4000-8000-000000000010",
  },
  usage: { kind: "unknown" },
}

// This consumer is JavaScript deliberately: malformed wire values must reach
// the runtime boundary without being cast into validated TypeScript types.
test("malformed persisted inputs fail through the JavaScript call boundary", async () => {
  const accepted = await Effect.runPromise(
    decideAttemptEvent(snapshot, identity, absent, terminal),
  )
  assert.equal(accepted.kind, "appended")
  for (const args of [
    [{ ...snapshot, sequence: -1 }, identity, absent, terminal],
    [snapshot, { ...identity, fence: "not-a-uuid" }, absent, terminal],
    [snapshot, identity, { kind: "recorded" }, terminal],
  ]) {
    const effect = Reflect.apply(decideAttemptEvent, undefined, args)
    assert.ok(Effect.isEffect(effect))
    const result = await Effect.runPromise(Effect.either(effect))
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") {
      assert.ok(result.left instanceof AttemptEventError)
      assert.equal(result.left.code, "malformed")
    }
  }
})
