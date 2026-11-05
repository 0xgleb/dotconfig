import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { getModels } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { clearTierCaches, tierCandidates } from "../shared/model-tiers.ts"

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

test("classifier candidate selection retains the SDK session model and supports no selected model", t => {
  clearTierCaches()
  t.after(clearTierCaches)
  const start = source.indexOf("const sessionClassifierModel =")
  const end = source.indexOf("const REVIEW_DUTY_RELAY_ATTEMPTS =", start)
  assert.ok(start >= 0 && end > start)
  const install = new Function(
    "tierCandidates",
    "classifierModelOverride",
    `${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })}\nreturn classifierCandidates;`,
  )
  const resolve: unknown = install(tierCandidates, () => undefined)
  assert.ok(typeof resolve === "function")
  const seed = getModels("openai")[0]
  assert.ok(seed, "configured SDK must provide its built-in model catalog")
  const model = { ...seed, id: "distinct-session-model-fixture" }
  const context: Pick<ExtensionContext, "cwd" | "model"> = {
    cwd: "/project",
    model,
  }
  const selected: unknown = Reflect.apply(resolve, undefined, [context])
  assert.deepEqual(selected, [
    ...tierCandidates("mid", { now: Date.now }),
    `${model.provider}/${model.id}`,
  ])
  const noModel: Pick<ExtensionContext, "cwd" | "model"> = {
    cwd: "/project",
    model: undefined,
  }
  const inherited: unknown = Reflect.apply(resolve, undefined, [noModel])
  assert.deepEqual(inherited, tierCandidates("mid", { now: Date.now }))
})

test("each classifier attempt runs on its own tier candidate", () => {
  const start = source.indexOf("const candidates = classifierCandidates(ctx)")
  assert.notEqual(start, -1, "classify must resolve tier candidates")
  const body = source.slice(start, start + 1600)
  assert.match(body, /attempt < attempts/)
  assert.match(
    body,
    /const candidate = candidates\[Math\.min\(attempt, candidates\.length - 1\)\]/,
  )
  assert.match(body, /candidate \? \["--model", candidate\] : \[\]/)
})
