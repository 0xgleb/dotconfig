import assert from "node:assert/strict"
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createExtensionDiagnostics } from "./extension-diagnostics.ts"

test("repeated errors display once while both traces go into a private file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-error-fixture-"))
  const path = join(dir, "trace.log")
  try {
    const diagnostics = createExtensionDiagnostics(path)
    const trace = "Error: fixture\n    at PRIVATE_TRACE_CANARY"
    assert.deepEqual(
      diagnostics.record("fixture.ts", "fixture failed", trace),
      {
        kind: "new",
        message: "Extension fixture.ts: fixture failed",
        path,
      },
    )
    assert.deepEqual(
      diagnostics.record("fixture.ts", "fixture failed", trace),
      { kind: "repeat" },
    )
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(
      readFileSync(path, "utf8").split("PRIVATE_TRACE_CANARY").length,
      3,
    )
  } finally {
    try {
      unlinkSync(path)
    } catch {}
    rmdirSync(dir)
  }
})
