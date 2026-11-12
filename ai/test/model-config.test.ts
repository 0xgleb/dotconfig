import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
const settings = JSON.parse(
  readFileSync(new URL("../pi.settings.json", import.meta.url), "utf8"),
)

test("Codex subscription models keep Pi's provider-specific context limits", () => {
  assert.doesNotMatch(
    home,
    /(?:providers\."openai-codex"\.modelOverrides\.)?"gpt-5\.6-(?:sol|terra|luna)"\.contextWindow/,
  )
})

test("the default Codex model uses the verified configured latest tier without lowering thinking", () => {
  assert.equal(settings.defaultProvider, "openai-codex")
  assert.equal(settings.defaultModel, "gpt-6.1-sol")
  assert.equal(settings.defaultThinkingLevel, "high")
})

test("parent Codex turns use bounded sustained-overload retries", () => {
  assert.deepEqual(settings.retry, {
    enabled: true,
    maxRetries: 5,
    baseDelayMs: 2000,
  })
})

test("Pi and shared agent skill roots use the same writable managed source", () => {
  assert.match(
    home,
    /skills\s*=\s*config\.lib\.file\.mkOutOfStoreSymlink\s+"\$\{aiDir\}\/skills"/,
  )
  assert.match(home, /"\.agents\/skills"\.source\s*=\s*skills;/)
  assert.match(home, /"\.pi\/agent\/skills"\.source\s*=\s*skills;/)
  assert.doesNotMatch(home, /emptyPiSkillRoot/)
})
