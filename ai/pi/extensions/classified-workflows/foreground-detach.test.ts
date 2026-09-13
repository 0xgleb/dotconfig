import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { shouldDetachForegroundWorkflow } from "./foreground-detach.ts"

test("foreground cancellation wiring accepts absent signals and removes live listeners", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = source.indexOf("      const abortWorkflow =")
  const end = source.indexOf("      let detachedWorkflow:", start)
  const cleanup = source.match(
    /signal\??\.removeEventListener\("abort", abortWorkflow\)/,
  )?.[0]
  assert.ok(start >= 0 && end > start && cleanup)
  const installBody = new Function(
    "workflowController",
    "signal",
    `${source.slice(start, end)}\nreturn () => { ${cleanup} }`,
  )
  const install = (
    workflowController: AbortController,
    signal: AbortSignal | undefined,
  ): (() => void) => {
    const dispose: unknown = installBody(workflowController, signal)
    assert.ok(typeof dispose === "function")
    return () => {
      dispose()
    }
  }
  const absent = new AbortController()
  install(absent, undefined)()
  assert.equal(absent.signal.aborted, false)
  const reason = new Error("cancel test")
  for (const alreadyAborted of [false, true]) {
    const upstream = new AbortController()
    const downstream = new AbortController()
    if (alreadyAborted) upstream.abort(reason)
    const dispose = install(downstream, upstream.signal)
    if (!alreadyAborted) upstream.abort(reason)
    assert.equal(downstream.signal.reason, reason)
    dispose()
  }
  const upstream = new AbortController()
  const downstream = new AbortController()
  install(downstream, upstream.signal)()
  upstream.abort(reason)
  assert.equal(downstream.signal.aborted, false)
})

test("human steering detaches a foreground workflow", () => {
  assert.equal(
    shouldDetachForegroundWorkflow("steer", "interactive", true),
    true,
  )
  assert.equal(shouldDetachForegroundWorkflow("steer", "rpc", true), true)
})

test("follow-ups and extension messages do not detach foreground work", () => {
  assert.equal(
    shouldDetachForegroundWorkflow("followUp", "interactive", true),
    false,
  )
  assert.equal(
    shouldDetachForegroundWorkflow("steer", "extension", true),
    false,
  )
  assert.equal(
    shouldDetachForegroundWorkflow("steer", "interactive", false),
    false,
  )
})
