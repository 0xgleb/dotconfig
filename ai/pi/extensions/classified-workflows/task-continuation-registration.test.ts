import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(
  new URL("./test-fixtures/task-continuation.ts", import.meta.url),
)
const support = fileURLToPath(
  new URL("../../../test/pi-host-test-support.mjs", import.meta.url),
)

test("registered task continuation rearms while host messages are queued and delivers after they clear", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-continuation-"))
  t.after(() => rmSync(root, { recursive: true }))

  const result = spawnSync(
    process.execPath,
    ["--import", support, fixture, root],
    {
      cwd: root,
      env: { HOME: root, XDG_STATE_HOME: join(root, "state") },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { sent: 1, queueChecks: 2 })
})
