import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  NushellUnavailableError,
  resolveNushellPath as resolveNushellPathEffect,
} from "./core.ts"

const resolveNushellPath = (
  ...args: Parameters<typeof resolveNushellPathEffect>
) => Effect.runSync(resolveNushellPathEffect(...args))

test("Nushell path resolution chooses a managed executable without a Bash fallback", () => {
  const existing = new Set(["/Users/example/.nix-profile/bin/nu"])
  assert.equal(
    resolveNushellPath("/Users/example", path => existing.has(path)),
    "/Users/example/.nix-profile/bin/nu",
  )
  const missing = Effect.runSync(
    Effect.either(resolveNushellPathEffect("/Users/example", () => false)),
  )
  assert.ok(Either.isLeft(missing))
  assert.ok(missing.left instanceof NushellUnavailableError)
})
