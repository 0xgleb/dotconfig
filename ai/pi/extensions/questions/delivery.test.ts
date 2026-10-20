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
assert.ok(start >= 0 && end > start)
const registration = stripTypeScriptTypes(source.slice(start, end))
const invoke = async (delivery: unknown, reviews: readonly unknown[] = []) => {
  let tool: { execute: Function } | undefined
  let inspected: readonly number[] = []
  const state = {
    questions: [{ id: 6, status: "pending", question: "Concrete proposal?" }],
  }
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
    reviewJobs: { snapshots: () => reviews },
    state,
    execution: undefined,
    inspectDelivery: async (ids: readonly number[]) => {
      inspected = ids
      return delivery
    },
    executeQuestionAction: () =>
      Effect.succeed({
        content: [{ type: "text", text: "q6 · Concrete proposal?" }],
        details: { outcome: "success", state },
      }),
  })
  assert.ok(tool)
  const result = await tool.execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "session-fixture" } },
  )
  return {
    result,
    inspected,
    text: result.content.map((part: { text: string }) => part.text).join("\n"),
  }
}

test("real question list reports private Telegram receipt status for exact pending question IDs", async () => {
  const { result, inspected, text } = await invoke([
    { id: 6, status: "telegram-delivered" },
  ])
  assert.equal(
    inspected.length,
    1,
    "the actual list boundary must inspect delivery instead of equating queued with sent",
  )
  assert.equal(inspected[0], 6)
  assert.match(text, /q6.*telegram-delivered/)
  assert.equal(result.details.deliveries[0].id, 6)
})

for (const delivery of [
  undefined,
  [null],
  [{ id: 7, status: "telegram-delivered" }],
  [{ id: 6, status: "forged" }],
  [
    { id: 6, status: "telegram-delivered" },
    { id: 6, status: "telegram-delivered" },
  ],
]) {
  test(`malformed or wrong-question delivery evidence is unavailable, not delivered: ${JSON.stringify(delivery)}`, async () => {
    const { text, result } = await invoke(delivery)
    assert.match(text, /delivery inspection unavailable/)
    assert.equal(result.details.deliveries, undefined)
  })
}

test("exact terminal job status leads the result and does not replay editorial feedback", async () => {
  const review = {
    id: "7159c485-a79a-4596-8dc1-8bdfaa94cb77",
    status: "needs-revision",
    pass: 2,
    reason: "PRIVATE_EDITORIAL_FEEDBACK",
  }
  const { result, text } = await invoke(
    [{ id: 6, status: "not-confirmed" }],
    [review],
  )
  assert.match(result.content[0].text, /7159c485-a79a-4596-8dc1-8bdfaa94cb77/)
  assert.match(
    result.content[0].text,
    /"status":"needs-revision","terminal":true/,
  )
  assert.doesNotMatch(text, /PRIVATE_EDITORIAL_FEEDBACK/)
  assert.equal(result.details.reviewJobs[0].reason, review.reason)
})

test("absence of a Telegram receipt remains not-confirmed", async () => {
  const { text } = await invoke([{ id: 6, status: "not-confirmed" }])
  assert.match(text, /q6.*not-confirmed/)
  assert.doesNotMatch(text, /telegram-delivered/)
})
