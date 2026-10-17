import assert from "node:assert/strict"
import test from "node:test"
import { sessionTokenUsage } from "./usage.ts"

test("session token usage includes assistant and nested tool model usage", () => {
  assert.deepEqual(
    sessionTokenUsage([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 10,
            totalTokens: 160,
          },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          usage: {
            input: 40,
            output: 8,
            cacheRead: 12,
            cacheWrite: 0,
            totalTokens: 60,
          },
        },
      },
      {
        type: "message",
        message: { role: "user", usage: { totalTokens: 999 } },
      },
      { type: "custom", data: { usage: { totalTokens: 999 } } },
    ]),
    {
      input: 140,
      output: 28,
      cacheRead: 42,
      cacheWrite: 10,
      totalTokens: 220,
    },
  )
})

test("session token usage rejects malformed and negative counters", () => {
  assert.deepEqual(
    sessionTokenUsage([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: -1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 8,
          },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 5,
            output: 6,
            cacheRead: 7,
            cacheWrite: 8,
            totalTokens: 26,
          },
        },
      },
    ]),
    {
      input: 5,
      output: 6,
      cacheRead: 7,
      cacheWrite: 8,
      totalTokens: 26,
    },
  )
})
