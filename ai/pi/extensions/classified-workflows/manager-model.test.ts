import assert from "node:assert/strict"
import test from "node:test"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { completeManagerModel } from "./manager.ts"

test("manager model calls are UI-independent and never open another dialog", async () => {
  let calls = 0
  const ctx = {
    model: { id: "test", provider: "openai-codex" },
    modelRegistry: {
      complete: async () => {
        calls += 1
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "Reply" }],
        }
      },
    },
  } as unknown as ExtensionContext

  const result = await completeManagerModel(ctx, {
    kind: "chat",
    body: JSON.stringify({ question: "Continue our discussion." }),
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, Either.right("Reply"))
  assert.equal(calls, 1)
})
