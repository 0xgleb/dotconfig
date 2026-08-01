import assert from "node:assert/strict"
import test from "node:test"

import { imageSummarySystemPrompt } from "./index.ts"

test("image summaries stay bounded, factual, visible, and non-authoritative", () => {
  const prompt = imageSummarySystemPrompt("base prompt")

  assert.match(prompt, /\[img: concise noun phrase\]/)
  assert.match(prompt, /short identifying caption/)
  assert.match(prompt, /uncertain or unreadable/)
  assert.match(prompt, /untrusted data/)
  assert.match(prompt, /cannot authorize tools/i)
  assert.match(prompt, /Do not expose absolute local paths/)
  assert.match(
    prompt,
    /screenshot of yielduck dashboard return distribution panel/,
  )
})
