import assert from "node:assert/strict"
import test from "node:test"
import { NushellUnavailableError, resolveNushellPath } from "./core.ts"

test("Nushell path resolution chooses a managed executable without a Bash fallback", () => {
  const existing = new Set(["/Users/example/.nix-profile/bin/nu"])
  assert.equal(
    resolveNushellPath("/Users/example", path => existing.has(path)),
    "/Users/example/.nix-profile/bin/nu",
  )
  assert.throws(
    () => resolveNushellPath("/Users/example", () => false),
    NushellUnavailableError,
  )
})
