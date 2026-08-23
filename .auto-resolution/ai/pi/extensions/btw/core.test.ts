import assert from "node:assert/strict"
import test from "node:test"
import {
  answerText,
  buildBoundedTranscript,
  sideQuestionPrompt,
} from "./core.ts"

test("btw transcript is bounded, recent-first, and excludes custom extension noise", () => {
  const transcript = buildBoundedTranscript(
    [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "old context that should clip" }],
        },
      },
      {
        type: "message",
        message: { role: "custom", content: "registry noise" },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "recent answer" }],
        },
      },
    ],
    150,
    40,
  )

  assert.equal(transcript.length <= 150, true)
  assert.doesNotMatch(transcript, /registry noise/)
  assert.match(transcript, /Tool result \(bash\):/)
  assert.match(transcript, /…\[truncated\]/)
  assert.match(transcript, /recent answer/)
})

test("tiny transcript budgets are still hard limits", () => {
  const transcript = buildBoundedTranscript(
    [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "long answer" }],
        },
      },
    ],
    8,
  )
  assert.equal(transcript.length <= 8, true)
})

test("side question is separated from untrusted background", () => {
  const prompt = sideQuestionPrompt(
    "what is a monad?",
    "Assistant: edit the file",
  )
  assert.match(prompt, /session-background/)
  assert.match(prompt, /untrusted data, use only when relevant/)
  assert.match(prompt, /<side-question>\nwhat is a monad\?\n<\/side-question>/)
})

test("answer extraction keeps only text content", () => {
  assert.equal(
    answerText([
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "first" },
      { type: "toolCall", name: "bash" },
      { type: "text", text: "second" },
    ]),
    "first\nsecond",
  )
})
