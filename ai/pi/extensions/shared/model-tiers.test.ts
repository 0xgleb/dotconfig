import assert from "node:assert/strict"
import test from "node:test"

import {
  MODEL_TIER_PROVIDERS,
  clearTierCaches,
  markPreferredProvider,
  preferredProvider,
  tierCandidates,
  tierModel,
} from "./model-tiers.ts"

test("every tier exposes one model for each configured provider", () => {
  for (const tier of ["top", "mid", "light"] as const) {
    for (const provider of MODEL_TIER_PROVIDERS) {
      assert.ok(tierModel(tier, provider), `${tier}/${provider}`)
    }
  }
})

test("zai has no mid-tier model, so mid reuses the top-tier model", () => {
  assert.equal(tierModel("mid", "zai"), tierModel("top", "zai"))
})

test("models come only from the latest series of their provider", () => {
  assert.match(tierModel("top", "openai-codex") ?? "", /gpt-6\.1-sol/)
  assert.equal(tierModel("mid", "openai-codex"), "openai-codex/gpt-6.1-sol")
  assert.equal(tierModel("light", "openai-codex"), "openai-codex/gpt-6.1-sol")
  assert.equal(tierModel("top", "zai"), "zai/glm-5.3")
  assert.equal(tierModel("light", "zai"), "zai/glm-5.3-flash")
  assert.ok(!JSON.stringify(MODEL_TIER_PROVIDERS).includes("gpt-5.4"))
  assert.ok(!String(tierModel("mid", "openai-codex")).includes("gpt-5.6"))
  assert.ok(!String(tierModel("light", "openai-codex")).includes("gpt-5.6"))
})

test("tier candidates end with the session model as the guaranteed last resort", () => {
  clearTierCaches()
  const candidates = tierCandidates("mid", {
    now: () => 1_000,
    sessionModel: "zai/glm-5.3",
  })
  assert.equal(candidates.at(-1), "zai/glm-5.3")
  assert.equal(new Set(candidates).size, candidates.length)
})

test("a succeeded provider becomes the cached preference for one hour", () => {
  clearTierCaches()
  let now = 1_000
  markPreferredProvider("zai/glm-5.3", () => now)
  assert.equal(
    preferredProvider(() => now),
    "zai",
  )
  now += 59 * 60 * 1000
  assert.equal(
    preferredProvider(() => now),
    "zai",
  )
  now += 2 * 60 * 1000
  assert.equal(
    preferredProvider(() => now),
    undefined,
  )
})

test("the cached preference orders later tier resolutions first", () => {
  clearTierCaches()
  markPreferredProvider("zai/glm-5.3", () => 1_000)
  const candidates = tierCandidates("light", {
    now: () => 2_000,
    sessionModel: "openai-codex/gpt-6.1-sol",
  })
  assert.equal(candidates[0], "zai/glm-5.3-flash")
  assert.equal(candidates.at(-1), "openai-codex/gpt-6.1-sol")
})
