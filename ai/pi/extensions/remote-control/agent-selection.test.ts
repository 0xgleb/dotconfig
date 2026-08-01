import assert from "node:assert/strict"
import test from "node:test"
import {
  agentListHtml,
  agentMatchesSelector,
  preferredAgent,
} from "./agent-selection.ts"
import type { BridgeAgent } from "./protocol.ts"

const agents: BridgeAgent[] = [
  {
    id: "019fba03-aaaa",
    label: ".config",
    cwd: "/Users/example/.config",
    accepting: true,
    heartbeatAt: 1,
    expiresAt: 2,
  },
  {
    id: "019fb9e8-bbbb",
    label: "yielduck",
    cwd: "/Users/example/code/dataclique/yielduck",
    accepting: true,
    heartbeatAt: 1,
    expiresAt: 2,
  },
]

test("human-readable labels and ID prefixes both select agents", () => {
  assert.equal(agentMatchesSelector(agents[0]!, ".config"), true)
  assert.equal(agentMatchesSelector(agents[0]!, "019fba03"), true)
  assert.equal(agentMatchesSelector(agents[1]!, ".config"), false)
})

test("dotconfig is the default unless an explicit selection remains live", () => {
  assert.equal(preferredAgent(agents)?.label, ".config")
  assert.equal(preferredAgent(agents, agents[1]!.id)?.label, "yielduck")
})

test("agent list exposes copyable Telegram code selectors", () => {
  const html = agentListHtml(agents)
  assert.match(html, /<code>\.config<\/code>/)
  assert.match(html, /<code>019fba03<\/code>/)
  assert.match(html, /<code>\/use \.config<\/code>/)
})
