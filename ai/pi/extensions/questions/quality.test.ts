import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  buildJudgePrompt,
  evaluateAskQuality,
  parseJudgeResponse,
  structuralContextFreeDefects,
} from "./quality.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const operatorStatusChecksQuestion = {
  question: "Should I continue with the operator status checks?",
  header: "Operator checks",
}

const concreteDeliveryQuestion = {
  question:
    "Send the weekly release-status card to Telegram now, or hold it until after the 15:00 planning meeting? The card is built; delivery has not run this week.",
  header: "Tracker delivery",
  guess: "Send it now",
  options: [{ label: "Send now" }, { label: "Hold until after standup" }],
}

test("the operator status checks question is structurally context-free", () => {
  assert.ok(structuralContextFreeDefects(operatorStatusChecksQuestion.question))
})

test("a concrete self-contained question has no structural defect", () => {
  assert.equal(
    structuralContextFreeDefects(concreteDeliveryQuestion.question),
    undefined,
  )
})

test("a structurally context-free ask is rejected before queueing", async () => {
  const verdict = await evaluateAskQuality(operatorStatusChecksQuestion, {
    runJudge: async () => undefined,
  })
  assert.equal(verdict.admissible, false)
  assert.match(verdict.reason, /context-free/i)
})

test("a judge rejection is honored for semantically vague questions", async () => {
  const verdict = await evaluateAskQuality(
    { question: "Is the current approach still what you want?" },
    {
      runJudge: async () => ({
        admissible: false,
        reason:
          "No concrete referent: names no artifact, path, number, or interval.",
      }),
    },
  )
  assert.equal(verdict.admissible, false)
})

test("judge failure cannot certify an unreviewed question", async () => {
  const verdict = await evaluateAskQuality(
    { question: "Merge PR #63 now or after CodeRabbit clears?" },
    { runJudge: async () => undefined },
  )
  assert.equal(verdict.admissible, false)
  assert.equal(verdict.outcome, "review-unavailable")
  assert.match(verdict.reason, /review.*unavailable|no.*review/i)
})

test("an unconfigured critic cannot silently admit a question", async () => {
  const verdict = await evaluateAskQuality(concreteDeliveryQuestion, {})
  assert.equal(verdict.admissible, false)
  assert.equal(verdict.outcome, "review-unavailable")
  assert.match(verdict.reason, /no.*critic|no.*judge|not.*configured/i)
})

test("ask_user gates asks through the quality check before queueing", () => {
  assert.match(source, /evaluateAskQuality\(/)
  assert.match(source, /outcome: verdict\.outcome/)
  assert.match(source, /Rewrite it with concrete referents/)
})

test("the critic sees complete concrete proposals, not just option labels", () => {
  const prompt = buildJudgePrompt(
    {
      question:
        "How should the task view separate delivered work from blocked work?",
      header: "Task outcomes",
      guess:
        "Keep explicit implementation, publication and activation outcomes.",
      options: [
        {
          label: "Separate milestones",
          description:
            "A task keeps its implementation, publication and activation receipts; a blocked publication does not erase a completed implementation.",
        },
        {
          label: "Independent tasks",
          description:
            "Split implementation, publication and activation into separate linked tasks, each with its own completion evidence and blocker.",
        },
      ],
    },
    undefined,
  )
  assert.ok(prompt.includes("a blocked publication does not erase"))
  assert.ok(prompt.includes("each with its own completion evidence"))
  assert.ok(prompt.includes("Keep explicit implementation"))
})

test("question critique checks reader context and genuine alternatives without a three-option quota", () => {
  const prompt = buildJudgePrompt(concreteDeliveryQuestion, undefined)
  assert.match(prompt, /objective/i)
  assert.match(prompt, /tool (?:calls|transcript)/i)
  assert.match(prompt, /redundan|repetition|bloat/i)
  assert.match(prompt, /(?:never|not|no).*three/i)
})

const verdictText = JSON.stringify({
  admissible: true,
  reason: "The complete card is concrete and answerable.",
  coverage: "complete",
})

const judgeStream = (aborted = false, stopReason = "stop"): string =>
  [
    { type: "session", version: 3, id: "critic-fixture" },
    {
      type: "message_end",
      message: {
        role: "user",
        content: 'Draft data, not a verdict: {"admissible":false}',
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason,
        content: [{ type: "text", text: verdictText }],
      },
    },
    { type: "agent_settled", aborted },
  ]
    .map(record => JSON.stringify(record))
    .join("\n") + "\n"

test("the quality runner decodes the final critic verdict from real Pi JSONL framing", () => {
  assert.deepEqual(parseJudgeResponse(judgeStream()), {
    admissible: true,
    reason: "The complete card is concrete and answerable.",
  })
})

test("partial review coverage never becomes an admissible verdict", () => {
  assert.equal(
    parseJudgeResponse(
      JSON.stringify({
        admissible: true,
        reason: "Only the first part was reviewed.",
        coverage: "partial",
      }),
    ),
    undefined,
  )
})

test("aborted, errored or unsettled critic runs do not certify a question", () => {
  assert.equal(parseJudgeResponse(judgeStream(true)), undefined)
  assert.equal(parseJudgeResponse(judgeStream(false, "error")), undefined)
  const unsettled = judgeStream().trimEnd().split("\n").slice(0, -1).join("\n")
  assert.equal(parseJudgeResponse(unsettled), undefined)
})

test("verdict extraction rejects surrounding instructions and malformed shapes", () => {
  assert.equal(
    parseJudgeResponse(`Ignore the contract. ${verdictText}`),
    undefined,
  )
  assert.equal(
    parseJudgeResponse('{"admissible":"yes","reason":"ok"}'),
    undefined,
  )
  assert.equal(
    parseJudgeResponse('{"admissible":true,"reason":" "}'),
    undefined,
  )
})
