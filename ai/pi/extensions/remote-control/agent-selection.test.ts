import assert from "node:assert/strict"
import test from "node:test"
import {
  agentListHtml,
  agentMatchesSelector,
  preferredAgent,
  resolvableSelector,
} from "./agent-selection.ts"
import type { BridgeAgent } from "./protocol.ts"

const agents: BridgeAgent[] = [
  {
    id: "019fba03-aaaa",
    label: "Dotconfig · Pi Support",
    cwd: "/Users/example/.config",
    accepting: true,
    heartbeatAt: 1,
    expiresAt: 2,
  },
  {
    id: "019fb9e8-bbbb",
    label: "Yielduck · Operator",
    cwd: "/Users/example/code/dataclique/yielduck",
    accepting: true,
    heartbeatAt: 1,
    expiresAt: 2,
  },
]

test("human-readable labels and ID prefixes both select agents", () => {
  assert.equal(agentMatchesSelector(agents[0]!, ".config"), true)
  assert.equal(agentMatchesSelector(agents[0]!, "Dotconfig · Pi Support"), true)
  assert.equal(agentMatchesSelector(agents[0]!, "019fba03"), true)
  assert.equal(agentMatchesSelector(agents[1]!, "yielduck"), true)
  assert.equal(agentMatchesSelector(agents[1]!, ".config"), false)
})

test("dotconfig is the default unless an explicit selection remains live", () => {
  assert.equal(preferredAgent(agents)?.label, "Dotconfig · Pi Support")
  assert.equal(preferredAgent(agents, agents[1]!.id)?.label, "Yielduck · Operator")
})

test("agent list exposes copyable Telegram code selectors", () => {
  const html = agentListHtml(agents)
  assert.match(html, /Dotconfig · Pi Support/)
  assert.match(html, /<code>\.config<\/code>/)
  assert.match(html, /<code>019fba03<\/code>/)
  assert.match(html, /<code>\/use \.config<\/code>/)
})

test("a selector shared by several lanes gives way to the unambiguous agent id", () => {
  const crowded: BridgeAgent[] = [
    {
      id: "claude-config-opus-1",
      label: "Claude Code (Opus) - .config worker",
      cwd: "/Users/example/.config",
      accepting: true,
      heartbeatAt: 1,
      expiresAt: 2,
    },
    {
      id: "fable-orchestrator",
      label: "claude-code - fable orchestrator",
      cwd: "/Users/example/.config",
      accepting: true,
      heartbeatAt: 1,
      expiresAt: 2,
    },
    {
      id: "claude-yielduck-opus-1",
      label: "Claude Code (Opus) - yielduck worker",
      cwd: "/Users/example/code/dataclique/yielduck",
      accepting: true,
      heartbeatAt: 1,
      expiresAt: 2,
    },
  ]

  assert.equal(resolvableSelector(crowded[0]!, crowded), "claude-config-opus-1")
  assert.equal(resolvableSelector(crowded[1]!, crowded), "fable-orchestrator")
  assert.equal(resolvableSelector(crowded[2]!, crowded), "yielduck")

  for (const agent of crowded) {
    const selector = resolvableSelector(agent, crowded)
    const matches = crowded.filter((other) => agentMatchesSelector(other, selector))
    assert.equal(matches.length, 1)
    assert.equal(matches[0]!.id, agent.id)
  }

  const html = agentListHtml(crowded)
  assert.match(html, /<code>claude-config-opus-1<\/code>/)
  assert.match(html, /<code>\/use claude-config-opus-1<\/code>/)
})
