import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { getPackageDir } from "@earendil-works/pi-coding-agent"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
const host = getPackageDir()
const rendering: unknown = await import(
  pathToFileURL(
    join(host, "dist/modes/interactive/components/assistant-message.js"),
  ).href
)
const themes: unknown = await import(
  pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href
)
assert.ok(
  record(rendering) &&
    typeof rendering.AssistantMessageComponent === "function",
)
assert.ok(
  record(themes) &&
    typeof themes.getThemeByName === "function" &&
    typeof themes.setThemeInstance === "function",
)
const MessageComponent = rendering.AssistantMessageComponent
const dark: unknown = themes.getThemeByName("dark")
assert.ok(record(dark) && typeof dark.getFgAnsi === "function")
themes.setThemeInstance(dark)
const errorColor: unknown = dark.getFgAnsi("error")
assert.equal(typeof errorColor, "string")
if (typeof errorColor !== "string")
  assert.fail("Expected the actual error color")

const aborted: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-responses",
  provider: "openai-codex",
  model: "offline-fixture",
  timestamp: 0,
  stopReason: "aborted",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
}
const render = (message: AssistantMessage): string => {
  const component: unknown = Reflect.construct(MessageComponent, [message])
  assert.ok(record(component) && typeof component.render === "function")
  const lines: unknown = component.render(100)
  assert.ok(
    Array.isArray(lines) && lines.every(line => typeof line === "string"),
  )
  return lines.join("\n")
}

for (const message of [
  aborted,
  { ...aborted, errorMessage: "Request was aborted" },
])
  test(`native aborted response is neutral control flow (${message.errorMessage ?? "no provider text"})`, () => {
    const output = render(message)
    assert.equal(
      output.includes(errorColor),
      false,
      "intentional interruption must not use the error palette",
    )
    assert.doesNotMatch(output, /Operation aborted/u)
    assert.match(output, /Cancelled|Interrupted/u)
  })

for (const errorMessage of [
  "Provider failure: Operation aborted",
  "Policy denied this operation",
])
  test(`genuine native error remains an error: ${errorMessage}`, () => {
    const output = render({ ...aborted, stopReason: "error", errorMessage })
    assert.equal(output.includes(errorColor), true)
    assert.ok(output.includes(errorMessage))
  })
