import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { classifierAttemptBudget } from "./lifecycle.ts"
import { tierCandidates } from "../shared/model-tiers.ts"

const fixture = fileURLToPath(
  new URL("./test-fixtures/classifier-retries.ts", import.meta.url),
)
const support = fileURLToPath(
  new URL("../../../test/pi-host-test-support.mjs", import.meta.url),
)
const candidates = tierCandidates("mid", { now: () => Date.now() })
const budget = Math.max(3, candidates.length + 1)
const cases = [
  [
    "aborted",
    "registered classification retries an aborted process and returns the later allow decision",
    2,
  ],
  [
    "process-error",
    "registered classification retries a process error and returns the later allow decision",
    2,
  ],
  [
    "exhausted",
    "registered classification exhausts its configured candidates and final retry",
    budget,
  ],
  [
    "cancelled",
    "parent cancellation stops registered classification after its first process",
    1,
  ],
  [
    "blocked",
    "a valid policy block returns from registered classification without retry",
    1,
  ],
] as const

test("classifier attempt budgets include a three-attempt minimum and one final-candidate retry", () => {
  assert.deepEqual([1, 2, 4].map(classifierAttemptBudget), [3, 3, 5])
})

for (const [scenario, name, calls] of cases)
  test(name, t => {
    const root = mkdtempSync(join(tmpdir(), "pi-classifier-retry-"))
    t.after(() => rmSync(root, { recursive: true }))

    const result = spawnSync(
      process.execPath,
      ["--import", support, fixture, root, scenario],
      {
        cwd: root,
        env: { HOME: root, XDG_STATE_HOME: join(root, "state") },
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
      },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { calls })
  })
