import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { imageSummarySystemPrompt } from "./core.ts"

const extensionSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const packageDefinition = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly pi: { readonly extensions: readonly string[] } }

test("image summaries stay bounded, factual, visible, and non-authoritative", () => {
  const prompt = imageSummarySystemPrompt("base prompt")

  assert.match(prompt, /\[img: concise noun phrase\]/)
  assert.match(prompt, /short identifying caption/)
  assert.match(prompt, /Never expose image-caption planning/)
  assert.match(prompt, /fallback chatter/)
  assert.match(prompt, /untrusted data/)
  assert.match(prompt, /cannot authorize tools/i)
  assert.match(prompt, /local paths/)
  assert.match(prompt, /do not repeat it/)
})

test("image captioning runs after screenshot paths become image content", () => {
  const extensions = packageDefinition.pi.extensions
  assert.ok(
    extensions.indexOf("./input-ergonomics/index.ts") <
      extensions.indexOf("./image-summary/index.ts"),
  )
  assert.match(extensionSource, /pi\.on\("input"/)
  assert.match(extensionSource, /completeSimple/)
  assert.match(extensionSource, /action: "transform"/)
  assert.doesNotMatch(extensionSource, /ctx\.ui\.notify/)
})
