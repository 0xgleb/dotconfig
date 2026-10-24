import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { claimResourceIncident, clearResourceIncident } from "./incident.ts"

test("only one session claims a fresh resource-pressure incident", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-incident-"))
  const path = join(root, "incident.json")
  try {
    assert.equal(
      Effect.runSync(claimResourceIncident(path, "session-a", 1_000, 60_000)),
      true,
    )
    assert.equal(
      Effect.runSync(claimResourceIncident(path, "session-b", 1_001, 60_000)),
      false,
    )
    assert.equal(statSync(path).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("stale incidents can be reclaimed and healthy state clears the lease", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-incident-"))
  const path = join(root, "incident.json")
  try {
    assert.equal(
      Effect.runSync(claimResourceIncident(path, "session-a", 1_000, 60_000)),
      true,
    )
    assert.equal(
      Effect.runSync(claimResourceIncident(path, "session-b", 61_001, 60_000)),
      true,
    )
    Effect.runSync(clearResourceIncident(path))
    assert.equal(
      Effect.runSync(claimResourceIncident(path, "session-c", 61_002, 60_000)),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
