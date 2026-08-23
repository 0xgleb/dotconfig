import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
const extensions = readFileSync(
  new URL("../pi/extensions/package.json", import.meta.url),
  "utf8",
)
const retiredWorkerPath = new URL(
  "../pi/extensions/grok-workspace/index.ts",
  import.meta.url,
)
const cursorRuntimeSources = [
  "../AGENTS.md",
  "../skills/register/SKILL.md",
  "../skills/pi-delegation/SKILL.md",
  "../skills/review-core/SKILL.md",
  "../skills/review-loop/SKILL.md",
  "../skills/review-pr/SKILL.md",
  "../skills/review-sweep/SKILL.md",
  "../skills/audit/SKILL.md",
  "../pi/extensions/control-plane/harness-protocol.ts",
  "../pi/extensions/control-plane/harness-adapter.ts",
  "../pi/extensions/control-plane/server.ts",
].map(path => readFileSync(new URL(path, import.meta.url), "utf8"))
const settings = JSON.parse(
  readFileSync(new URL("../pi.settings.json", import.meta.url), "utf8"),
)

test("Codex subscription models keep Pi's provider-specific context limits", () => {
  assert.doesNotMatch(
    home,
    /(?:providers\."openai-codex"\.modelOverrides\.)?"gpt-5\.6-(?:sol|terra|luna)"\.contextWindow/,
  )
})

test("retired Cursor workers are absent from the managed installation", () => {
  assert.doesNotMatch(home, /\bcursor-cli\b/)
  assert.doesNotMatch(extensions, /grok-workspace/)
  assert.equal(existsSync(retiredWorkerPath), false)
  assert.doesNotMatch(
    cursorRuntimeSources.join("\n"),
    /cursor-agent|cursor-subscription|grok_workspace/,
  )
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
    /"\.agents\/skills"\.source\s*=\s*config\.lib\.file\.mkOutOfStoreSymlink\s+"\$\{aiDir\}\/skills"/,
  )
  assert.match(
    home,
    /"\.pi\/agent\/skills"\.source\s*=\s*config\.lib\.file\.mkOutOfStoreSymlink\s+"\$\{aiDir\}\/skills"/,
  )
  assert.doesNotMatch(home, /emptyPiSkillRoot/)
})
