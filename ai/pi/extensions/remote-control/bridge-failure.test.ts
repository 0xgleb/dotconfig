import assert from "node:assert/strict"
import test from "node:test"

import { bridgeFailureText } from "./bridge-failure.ts"
import type { RemoteMessage } from "./protocol.ts"

const failed = (
  failure: Extract<RemoteMessage, { status: "failed" }>["failure"],
  claimedAt?: number,
): Extract<RemoteMessage, { status: "failed" }> => ({
  id: "message-1",
  targetAgentId: "agent-1",
  requesterId: "owner-1",
  dedupeKey: "update-1",
  text: "question",
  images: [],
  createdAt: 1,
  expiresAt: 60 * 60_000,
  updatedAt: 60 * 60_000,
  status: "failed",
  failure,
  completedAt: 60 * 60_000,
  ...(claimedAt === undefined ? {} : { claimedAt }),
})

test("expiry diagnostics distinguish queue starvation from claimed execution", () => {
  assert.match(
    bridgeFailureText(failed("expired")),
    /before a Pi agent claimed it/i,
  )
  assert.match(bridgeFailureText(failed("expired")), /not processed/i)
  assert.match(
    bridgeFailureText(failed("expired", 42)),
    /claimed.*did not finish/i,
  )
  assert.doesNotMatch(
    bridgeFailureText(failed("expired", 42)),
    /not processed/i,
  )
})

test("typed bridge failures provide actionable bounded diagnostics", () => {
  assert.match(
    bridgeFailureText(failed("model_error", 42)),
    /model turn failed/i,
  )
  assert.match(
    bridgeFailureText(failed("bridge_disabled")),
    /bridge was disabled/i,
  )
  for (const failure of ["aborted", "session_ended"] as const) {
    assert.ok(bridgeFailureText(failed(failure)).length <= 320)
  }
})
