import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"

import { reloadAfterIdle as boundary } from "./manual-reload.ts"

test("reload waits for the streaming turn to end instead of accepting the TUI busy no-op", async () => {
  const events: string[] = []
  let streaming = true
  let release: () => void = () => {}
  const idle = new Promise<void>(resolve => {
    release = resolve
  })
  const operation = await boundary({
    waitForIdle: async () => {
      events.push("waiting")
      await idle
      streaming = false
    },
    reload: async () => {
      events.push(streaming ? "silently-skipped" : "reloaded")
    },
  })
  const pending = Effect.runPromise(operation)
  await Promise.resolve()
  assert.deepEqual(events, ["waiting"])
  release()
  await pending
  assert.deepEqual(events, ["waiting", "reloaded"])
})

test("idle and reload failures remain typed and never masquerade as success", async () => {
  for (const phase of ["idle", "reload"]) {
    let calls = 0
    const operation = await boundary({
      waitForIdle: async () => {
        if (phase === "idle") throw new Error("fixture idle")
      },
      reload: async () => {
        calls++
        throw new Error("fixture reload")
      },
    })
    const outcome = await Effect.runPromise(Effect.either(operation))
    assert.ok(Either.isLeft(outcome))
    assert.equal(outcome.left.phase, phase)
    assert.equal(calls, phase === "idle" ? 0 : 1)
  }
})
