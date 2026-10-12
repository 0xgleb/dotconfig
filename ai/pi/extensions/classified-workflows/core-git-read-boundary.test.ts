import assert from "node:assert/strict"
import test from "node:test"
import { deterministicDecision } from "./core.ts"

test("executable expressions cannot borrow deterministic Git read-only allowance", () => {
  for (const command of [
    'git status --short -- (print "fixture")',
    'git diff --name-only -- $"(print fixture)"',
    'git status --short -- "$(printf fixture)"',
    "git status --short & printf fixture",
    "git diff -- (print fixture) ':(glob,exclude)**/.env'",
    "git diff --unknown-option -- . ':(glob,exclude)**/.env'",
  ]) {
    const decision = deterministicDecision({
      boundary: "action",
      toolName: "bash",
      input: { command },
      cwd: "/repo",
    })
    assert.notEqual(decision?.verdict, "allow", command)
  }
})

test("literal path data retain read-only allowance without becoming a command-shape ban", () => {
  for (const command of [
    'git status --short -- "plain path.ts"',
    "git diff --name-only -- 'literal($word).ts'",
  ]) {
    assert.equal(
      deterministicDecision({
        boundary: "action",
        toolName: "bash",
        input: { command },
        cwd: "/repo",
      })?.verdict,
      "allow",
    )
  }
})
