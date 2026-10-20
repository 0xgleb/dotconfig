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

for (const fixture of [
  {
    result: { outcome: "updated", id: 6, messageId: 42, textLinks: 2 },
    outcome: "updated",
    error: false,
  },
  {
    result: {
      outcome: "unavailable",
      id: 6,
      reason: "Already matches; no new entity receipt.",
      reasonKind: "already-current",
    },
    outcome: "unchanged",
    error: false,
  },
  {
    result: {
      outcome: "unavailable",
      id: 6,
      reason: "HTTP400, unknown rejection.",
    },
    outcome: "unavailable",
    error: true,
  },
])
  test(`refresh ${fixture.outcome} preserves the exact card and does not re-review`, async () => {
    let tool: { execute: Function } | undefined
    let refreshed = 0
    let transitioned = 0
    const state = {
      questions: [
        {
          id: 6,
          status: "pending",
          question: "Previously reviewed unchanged proposal.",
        },
      ],
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
      state,
      execution: {
        admit: () => Either.right({ deadlineAt: Date.now() + 60_000 }),
      },
      inspectDelivery: undefined,
      refreshDelivery: async (id: number) => {
        assert.equal(id, 6)
        refreshed++
        return fixture.result
      },
      evaluateAskQuality: () => {
        assert.fail("unchanged rendering is not a new draft")
      },
      executeQuestionAction: () => {
        transitioned++
        return Effect.succeed({ content: [], details: { outcome: "success" } })
      },
    })
    assert.ok(tool)
    const result = await tool.execute(
      "refresh",
      { action: "refresh_delivery", id: 6 },
      undefined,
      undefined,
      {},
    )
    assert.equal(
      refreshed,
      1,
      "the native tool must invoke its private rendering updater",
    )
    assert.equal(
      transitioned,
      0,
      "do not withdraw, replace, resolve or reopen the decision",
    )
    assert.equal(result.details.outcome, fixture.outcome)
    assert.equal(result.isError === true, fixture.error)
    if (fixture.outcome === "unchanged")
      assert.equal(
        result.details.textLinks,
        undefined,
        "no receipt means no fabricated entity count",
      )
    assert.equal(state.questions.length, 1)
    assert.equal(state.questions[0]?.status, "pending")
  })
