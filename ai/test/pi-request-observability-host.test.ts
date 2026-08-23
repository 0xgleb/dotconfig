import assert from "node:assert/strict"
import { channel } from "node:diagnostics_channel"
import test from "node:test"

import {
  RequestLifecyclePhase,
  classifyRequestFailure,
  createRequestLifecycle,
  currentRequestLifecycle,
  publishRequestLifecycle,
  withRequestLifecycle,
} from "../pi/host/request-lifecycle.js"

test("host lifecycle publisher emits safe correlated diagnostic events", () => {
  const received: unknown[] = []
  const lifecycleChannel = channel("pi.request.lifecycle")
  const listener = (message: unknown) => received.push(message)
  lifecycleChannel.subscribe(listener)
  try {
    const lifecycle = createRequestLifecycle({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    })
    publishRequestLifecycle(lifecycle, RequestLifecyclePhase.AuthStarted)
    assert.equal(received.length, 1)
    const event = received[0] as Record<string, unknown>
    assert.equal(event.signal, "pi.auth.phase")
    assert.equal(event.phase, "auth.started")
    assert.equal(event.requestId, lifecycle.requestId)
    assert.equal(event.provider, "openai-codex")
    assert.equal(event.model, "gpt-5.6-sol")
    assert.equal("payload" in event, false)
    assert.equal("headers" in event, false)
    assert.equal("error" in event, false)
  } finally {
    lifecycleChannel.unsubscribe(listener)
  }
})

test("host failure classification is bounded and never returns error text", () => {
  assert.equal(classifyRequestFailure({ code: "ELOCKED" }), "lock")
  assert.equal(classifyRequestFailure({ code: "oauth" }), "auth")
  assert.equal(
    classifyRequestFailure(new Error("provider response contained a secret")),
    "unknown",
  )
})

test("host lifecycle correlation survives asynchronous request boundaries", async () => {
  const lifecycle = await withRequestLifecycle(
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    async started => {
      await Promise.resolve()
      assert.equal(currentRequestLifecycle(), started)
      return started
    },
  )
  assert.equal(currentRequestLifecycle(), undefined)
  assert.equal(typeof lifecycle.requestId, "string")
})
