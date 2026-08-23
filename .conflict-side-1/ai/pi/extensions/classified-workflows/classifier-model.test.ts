import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("routine classifier calls use Terra rather than the largest subscription model", () => {
  assert.match(source, /CLASSIFIER_MODEL = "openai-codex\/gpt-5\.6-terra"/)
  assert.doesNotMatch(source, /CLASSIFIER_MODEL = "openai-codex\/gpt-5\.6-sol"/)
})
