import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(
  new URL("./test-fixtures/workflow-events.ts", import.meta.url),
)
const hostSupport = fileURLToPath(
  new URL("../../../test/pi-host-test-support.mjs", import.meta.url),
)
const cases = [
  [
    "snapshots",
    "malformed question snapshots are rejected through registered handlers",
    8,
  ],
  ["resolutions", "malformed resolutions preserve the actual paused state", 4],
  ["handshakes", "malformed handshakes preserve the actual open circuit", 4],
  ["notice", "invalid events produce only local non-turning notices", 1],
  ["stale", "invalid events remain rejected when the local sender fails", 1],
  [
    "valid",
    "valid resolution and capability events persist actual recovery transitions",
    1,
  ],
] as const

for (const [scenario, name, count] of cases)
  test(name, t => {
    const root = mkdtempSync(join(tmpdir(), "pi-workflow-event-"))
    t.after(() => rmSync(root, { recursive: true }))

    const result = spawnSync(
      process.execPath,
      ["--import", hostSupport, fixture, root, scenario],
      {
        cwd: root,
        env: { HOME: root, XDG_STATE_HOME: join(root, "state") },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { cases: count })
  })
