import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Data, Effect, Either } from "effect"
import { Type } from "typebox"
import * as state from "./state.ts"
import * as events from "../shared/question-events.ts"
import { createOwnerAllowance } from "../classified-workflows/owner-allowance.ts"
import {
  createQuestionReviewJobs,
  decodeQuestionDraft,
  QUESTION_REVIEW_ENTRY,
} from "./review-jobs.ts"
import { pendingQuestionContext, questionListText } from "./presentation.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const factory = stripTypeScriptTypes(
  source.slice(
    source.indexOf("const QUESTION_MESSAGE ="),
    source.lastIndexOf("\nexport default"),
  ),
)

test("actual complete extension wires background revision to final question state, not the foreground", async t => {
  const handlers = new Map<string, Function>()
  const bus = new Map<string, Function>()
  const entries: unknown[] = []
  let tool: { execute: Function } | undefined
  let first!: (output: string) => void
  const waiting = new Promise<string>(resolve => {
    first = resolve
  })
  const roles: string[] = []
  const guard = createOwnerAllowance({
    now: Date.now,
    schedule: () => 0,
    clear: () => {},
    persist: () => {},
    cancel: () => {},
  })
  guard.ownerInput(Date.now())
  const revised = {
    question: "Should file.ts admit at most four queued drafts?",
    header: "Queue",
    guess: "Use the bounded queue.",
    options: [{ label: "Use queue" }, { label: "Keep current" }],
  }
  const sandbox = {
    ...state,
    ...events,
    Data,
    Effect,
    Either,
    Type,
    createQuestionReviewJobs,
    decodeQuestionDraft,
    QUESTION_REVIEW_ENTRY,
    pendingQuestionContext,
    questionListText,
    registerRuntimeVersion: () => {},
    runContentProcess: async (_ctx: unknown, task: { role: string }) => {
      roles.push(task.role)
      return roles.length === 1
        ? waiting
        : task.role === "author"
          ? JSON.stringify(revised)
          : JSON.stringify({
              admissible: true,
              coverage: "complete",
              reason: "Self-contained and scoped.",
            })
    },
  }
  runInNewContext(
    `${factory}\nglobalThis.makeQuestions = questionsExtension`,
    sandbox,
  )
  const pi = {
    on: (event: string, handler: Function) => {
      handlers.set(event, handler)
    },
    events: {
      on: (event: string, handler: Function) => {
        bus.set(event, handler)
      },
      emit: () => {},
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data })
    },
    registerCommand: () => {},
    registerTool: (value: { execute: Function }) => {
      tool = value
    },
    sendMessage: () => {},
  }
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "openai-codex", id: "gpt-6.1-sol" },
    hasUI: false,
    sessionManager: {
      getSessionId: () => "integration",
      getBranch: () => entries,
    },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
  }
  ;(sandbox as unknown as { makeQuestions: Function }).makeQuestions(pi, guard)
  t.after(() => {
    handlers.get("session_shutdown")?.({}, ctx)
    guard.dispose()
  })
  handlers.get("session_start")?.({}, ctx)
  assert.ok(tool)
  const result = await tool.execute(
    "ask",
    {
      action: "ask",
      question: "Should file.ts use a bounded queue?",
      header: "Queue",
      guess: "Use the bounded queue.",
      options: revised.options,
    },
    undefined,
    undefined,
    ctx,
  )
  assert.equal(result.details.outcome, "queued-review")
  for (let i = 0; i < 4; i++)
    await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(roles, ["critic"])
  let listed = await tool.execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    ctx,
  )
  assert.equal(listed.details.state.questions.length, 0)
  assert.equal(listed.details.reviewJobs[0].status, "reviewing")
  first(
    JSON.stringify({
      admissible: false,
      coverage: "complete",
      reason: "Explain the concrete capacity, not just bounded.",
    }),
  )
  for (let i = 0; i < 16; i++)
    await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(roles, ["critic", "author", "critic"])
  listed = await tool.execute(
    "list",
    { action: "list" },
    undefined,
    undefined,
    ctx,
  )
  assert.equal(listed.details.state.questions.length, 1)
  assert.equal(listed.details.state.questions[0].question, revised.question)
  assert.equal(listed.details.reviewJobs[0].status, "queued-question")
  assert.equal(
    listed.details.reviewJobs[0].questionId,
    listed.details.state.questions[0].id,
  )
  const before = roles.length
  await bus.get(events.QUESTION_ASK_EVENT)?.({ question: 5 })
  assert.equal(
    roles.length,
    before,
    "malformed bus data is rejected before review",
  )
})
