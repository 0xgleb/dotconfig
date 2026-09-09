import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")

const source = read("./index.ts")
const packageManifest = JSON.parse(read("../package.json")) as {
  pi: { extensions: string[] }
}

test("write-result inspector runs before normal classified tool-result filtering", () => {
  const extensions = packageManifest.pi.extensions
  const inspector = extensions.indexOf("./write-result-inspector/index.ts")
  const classifier = extensions.indexOf("./classified-workflows/index.ts")
  assert.ok(inspector >= 0)
  assert.ok(classifier >= 0)
  assert.ok(inspector < classifier)
})

test("extension inspects only successful edit/write results", () => {
  assert.match(source, /pi\.on\("tool_result"/)
  assert.match(source, /event\.isError/)
  assert.match(source, /mutationDeltaFromSuccessfulToolResult/)
  assert.match(source, /event\.toolName/)
  assert.match(source, /event\.toolCallId/)
})

test("lifecycle owns cancellation and never injects an asynchronous message", () => {
  assert.match(source, /pi\.on\("session_start"/)
  assert.match(source, /pi\.on\("session_shutdown"/)
  assert.match(source, /controller\.abort\(\)/)
  assert.match(source, /batcher\.cancel/)
  assert.doesNotMatch(source, /sendMessage|sendUserMessage|appendEntry/)
})

test("project instructions are captured structurally rather than rediscovered", () => {
  assert.match(source, /pi\.on\("before_agent_start"/)
  assert.match(source, /systemPromptOptions\.contextFiles/)
  assert.doesNotMatch(
    source,
    /getSystemPrompt\(\)|\breaddir\b|\bglob\b|pi\.exec\(["'](?:find|rg)["']/,
  )
})

test("deterministic checks precede one bounded Luna call and usage is patched", () => {
  assert.match(source, /runDeterministicChecks/)
  assert.match(source, /runLunaInspector/)
  assert.match(source, /runInspectionBatch/)
  assert.match(source, /inspectionResultPatch/)
  assert.match(source, /MutationBatcher/)
  assert.match(
    source,
    /registerRuntimeVersion\(pi, "write-result-inspector", "2026\.09\.04\.1"\)/,
  )
})
