import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { globalQuestionsText } from "./question-list.ts"
import type { BridgeAgent, BridgeQuestion } from "./protocol.ts"

const pieceSource = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
  "utf8",
)

const agents: BridgeAgent[] = [
  {
    id: "agent-y",
    label: "Yielduck · Operator",
    cwd: "/code/dataclique/yielduck",
    heartbeatAt: 1,
    expiresAt: 2,
    accepting: true,
    workDelivery: "native-pi",
    queuedMessages: 0,
  },
  {
    id: "agent-d",
    label: "Dotconfig · Pi Support",
    cwd: "/Users/example/.config",
    heartbeatAt: 1,
    expiresAt: 2,
    accepting: true,
    workDelivery: "native-pi",
    queuedMessages: 0,
  },
]

const questions: BridgeQuestion[] = [
  {
    agentId: "agent-y",
    questionId: 12,
    header: "Maker evidence",
    question: "What minimum live evidence window should satisfy the gate?",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    agentId: "agent-d",
    questionId: 37,
    header: "Hardening intent",
    question: "Are the consolidated assumptions correct?",
    createdAt: 2,
    updatedAt: 2,
  },
]

test("global questions identify every live agent without raw session IDs", () => {
  const text = globalQuestionsText(questions, agents)
  assert.match(text, /Pending questions · 2/)
  assert.match(text, /Yielduck · Operator[\s\S]*q12 · Maker evidence/)
  assert.match(text, /Dotconfig · Pi Support[\s\S]*q37 · Hardening intent/)
  assert.doesNotMatch(text, /agent-y|agent-d/)
  assert.match(text, /Reply to the original question card/)
})

test("Piece of Pi registers and handles global questions without a model turn", () => {
  assert.match(pieceSource, /command: "questions"/)
  assert.match(
    pieceSource,
    /command === "\/questions"[\s\S]*?listPendingQuestions[\s\S]*?globalQuestionsText/,
  )
})

test("global questions reports an empty inbox concisely", () => {
  assert.equal(globalQuestionsText([], agents), "No pending Pi questions.")
})
