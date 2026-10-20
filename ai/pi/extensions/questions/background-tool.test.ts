import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Effect, Either } from "effect"
import { Type } from "typebox"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const start = source.indexOf('  pi.registerTool({\n    name: "ask_user"')
const end = source.lastIndexOf("\n}\n\nexport default")
const registration = stripTypeScriptTypes(source.slice(start, end))

test("actual ask boundary returns queued-review without awaiting the critic or requesting a foreground rewrite", async () => {
  let tool: { execute: Function } | undefined
  let queued = 0
  runInNewContext(registration, {
    Effect,
    Either,
    Type,
    pi: {
      registerTool: (value: { execute: Function }) => {
        tool = value
      },
    },
    restore: () => {},
    state: { questions: [] },
    execution: {
      admit: () => Either.right({ deadlineAt: Date.now() + 60_000 }),
    },
    askQualityDepsFor: () => ({}),
    judgeContextFor: () => ({}),
    evaluateAskQuality: () => new Promise(() => {}),
    queueQuestionReview: async () => {
      queued++
      return {
        content: [{ type: "text", text: "Background question review queued." }],
        details: { outcome: "queued-review", jobId: "fixture" },
      }
    },
  })
  assert.ok(tool)
  let settled = false
  const result = tool
    .execute(
      "ask",
      { action: "ask", question: "Concrete file.ts proposal?" },
      undefined,
      undefined,
      {},
    )
    .then((value: unknown) => {
      settled = true
      return value
    })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, true, "ask_user must not wait for its model reviewer")
  assert.equal(queued, 1)
  const value = await result
  assert.equal(value.details.outcome, "queued-review")
})
