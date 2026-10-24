import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("classifier model is not hardcoded to one provider", () => {
  assert.doesNotMatch(source, /CLASSIFIER_MODEL = "/)
  assert.doesNotMatch(source, /gpt-5\.6-terra"/)
})

test("classifier resolves models through the shared tier module", () => {
  assert.match(source, /from "\.\.\/shared\/model-tiers\.ts"/)
  assert.match(source, /tierCandidates\("mid"/)
  assert.match(source, /markPreferredProvider\(/)
})

test("an explicit environment override still wins before tier candidates", () => {
  assert.match(source, /PI_CLASSIFIER_MODEL/)
})

test("classifier and goal evaluator accept the session model context", () => {
  assert.match(source, /Pick<ExtensionContext, "cwd" \| "getModel">/)
})

test("each classifier attempt runs on its own tier candidate", () => {
  const start = source.indexOf("const candidates = classifierCandidates(ctx)")
  assert.notEqual(start, -1, "classify must resolve tier candidates")
  const body = source.slice(start, start + 1600)
  assert.match(body, /attempt < attempts/)
  assert.match(
    body,
    /"--model",\s*candidates\[Math\.min\(attempt, candidates\.length - 1\)\]/,
  )
})
