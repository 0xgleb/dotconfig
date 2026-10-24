import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import test from "node:test"
import { Either } from "effect"
import { createOwnerAllowance } from "../classified-workflows/owner-allowance.ts"
import { evaluateAskQuality, makeQuestionJudge } from "./quality.ts"

test("unavailable question review retains the native failure reason", async () => {
  const result = await evaluateAskQuality(
    { question: "Should file.ts use option A?" },
    {
      runJudge: async () => undefined,
      reviewUnavailableReason: () => "Critic process exited with status 17.",
    },
  )
  assert.equal(result.outcome, "review-unavailable")
  assert.match(result.reason, /status 17/)
})

test("a failed native process reports a bounded typed cause without exposing stderr", async t => {
  const guard = createOwnerAllowance({
    now: Date.now,
    schedule: () => 0,
    clear: () => {},
    persist: () => {},
    cancel: () => {},
  })
  assert.ok(Either.isRight(guard.ownerInput(Date.now())))
  const original = childProcess.spawn
  const mocked = t.mock.method(childProcess, "spawn", () =>
    original(
      process.execPath,
      [
        "-e",
        "process.stderr.write('synthetic private error'); process.exit(17)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    ),
  )
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
    guard.dispose()
  })
  let cause: unknown
  const result = await makeQuestionJudge({
    cwd: process.cwd(),
    execution: guard,
    getModel: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }),
    onUnavailable: (value: unknown) => {
      cause = value
    },
  })("Diagnostic-only fixture.")
  assert.equal(result, undefined)
  assert.deepEqual(cause, { code: "process-exited", exitCode: 17 })
  assert.ok(!JSON.stringify(cause).includes("synthetic private error"))
})
