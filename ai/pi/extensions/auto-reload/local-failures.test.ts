import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(
  new URL("./test-fixtures/local-failure.ts", import.meta.url),
)
const hostSupport = fileURLToPath(
  new URL("../../../test/pi-host-test-support.mjs", import.meta.url),
)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
const failureReporter = (
  t: test.TestContext,
  scenario: "notice" | "stale" | "bounded",
) => {
  const root = mkdtempSync(join(tmpdir(), "pi-reload-fixture-"))
  t.after(() => rmSync(root, { recursive: true }))

  const result = spawnSync(
    process.execPath,
    ["--import", hostSupport, fixture, root, scenario],
    {
      cwd: root,
      env: {
        HOME: root,
        XDG_STATE_HOME: join(root, "state"),
        PI_AUTO_RELOAD: "enabled",
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  )

  assert.equal(result.status, 0, result.stderr)

  const output: unknown = JSON.parse(result.stdout)

  assert.ok(
    record(output) &&
      Array.isArray(output.attempts) &&
      Array.isArray(output.messages) &&
      Array.isArray(output.logs),
  )

  return {
    attempts: output.attempts,
    messages: output.messages,
    logs: output.logs,
  }
}

test("reload failure stays visible locally without starting a turn", t => {
  const runtime = failureReporter(t, "notice")

  assert.deepEqual(runtime.messages, [
    {
      message: {
        customType: "auto-reload.failure",
        content:
          "warning: watch managed Pi resources: Could not watch managed Pi path: probe failed",
        display: true,
      },
      options: { triggerTurn: false },
    },
  ])
  assert.deepEqual(runtime.attempts, runtime.messages)
  assert.deepEqual(runtime.logs, [])
})

test("a stale notice sender cannot interrupt recovery or expose its error", t => {
  const runtime = failureReporter(t, "stale")

  assert.equal(runtime.attempts.length, 1)
  assert.deepEqual(runtime.messages, [])
  assert.deepEqual(
    runtime.logs.map(value => {
      assert.ok(typeof value === "string")

      return JSON.parse(value)
    }),
    [
      {
        level: "error",
        component: "auto-reload",
        event: "notice-delivery-failed",
        operation: "watch managed Pi resources",
      },
    ],
  )
  assert.doesNotMatch(runtime.logs.join("\n"), /sensitive/u)
})

test("local reload failure retains bounded single-line diagnostics", t => {
  const runtime = failureReporter(t, "bounded")

  assert.equal(runtime.messages.length, 1)
  const delivery: unknown = runtime.messages[0]
  assert.ok(
    record(delivery) &&
      record(delivery.message) &&
      typeof delivery.message.content === "string",
  )

  const prefix = "warning: watch managed Pi resources: "
  assert.ok(delivery.message.content.startsWith(prefix))
  assert.equal(delivery.message.content.slice(prefix.length).length, 240)
  assert.doesNotMatch(delivery.message.content, /[\u0000-\u001f\u007f]/u)
  assert.deepEqual(delivery.options, { triggerTurn: false })
  assert.deepEqual(runtime.attempts, runtime.messages)
  assert.deepEqual(runtime.logs, [])
})
