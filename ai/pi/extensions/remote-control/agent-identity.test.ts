import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { agentDisplayLabel, identifiedAgentLabel } from "./agent-identity.ts"
import type { BridgeAgent } from "./protocol.ts"

const registrySource = readFileSync(
  new URL("../agent-registry/index.ts", import.meta.url),
  "utf8",
)
const remoteControlSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)
const pieceSource = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
  "utf8",
)

const agent = (id: string, label: string): BridgeAgent => ({
  id,
  label,
  cwd: "/Users/example/code/dataclique/yielduck",
  accepting: true,
  workDelivery: "native-pi",
  queuedMessages: 0,
  heartbeatAt: 1,
  expiresAt: 2,
})

test("agent display labels combine a friendly project and declared role", () => {
  assert.equal(
    agentDisplayLabel("yielduck", [{ role: "developer", mode: "operational" }]),
    "Yielduck · Developer",
  )
  assert.equal(
    agentDisplayLabel(".config", [{ role: "maintainer", mode: "operational" }]),
    "Dotconfig · Maintainer",
  )
  assert.equal(agentDisplayLabel("st0x-review-duty", []), "ST0x Review Duty")
})

test("registry-owned roles feed the bridge heartbeat through a typed identity event", () => {
  assert.match(
    registrySource,
    /REGISTRY_IDENTITY_REQUEST_EVENT[\s\S]*?resolveRuntimeAgentId\(payload\.agentId\)[\s\S]*?lease\.owner\.id === agentId && lease\.status === "active"[\s\S]*?payload\.report\(\{ role: lease\.role, mode: lease\.mode \}\)/,
  )
  assert.match(
    remoteControlSource,
    /REGISTRY_IDENTITY_REQUEST_EVENT[\s\S]*?agentDisplayLabel[\s\S]*?heartbeatAgent/,
  )
})

test("question relays and confirmations use friendly identities without raw session IDs", () => {
  const relay = pieceSource.slice(
    pieceSource.indexOf("const questionRelayText"),
    pieceSource.indexOf("const relayPendingQuestions"),
  )
  const reply = pieceSource.slice(
    pieceSource.indexOf("const handleQuestionReply"),
    pieceSource.indexOf("const handleOwnerCommand"),
  )
  assert.match(relay, /identifiedAgentLabel/)
  assert.doesNotMatch(relay, /id\.slice/)
  assert.match(reply, /identifiedAgentLabel/)
  assert.doesNotMatch(reply, /agentId\.slice/)
})

test("a direct numbered owner message tries the sole pending delivered question without guessing", () => {
  const reply = pieceSource.slice(
    pieceSource.indexOf("const handleQuestionReply"),
    pieceSource.indexOf("const handleOwnerCommand"),
  )
  assert.match(reply, /answerSolePendingTelegramQuestion/)
  assert.match(reply, /replyToMessageId === undefined/)
  assert.match(reply, /resolution === undefined/)
})

test("duplicate friendly identities receive deterministic instance numbers", () => {
  const agents = [
    agent("019f-a", "Yielduck · Developer"),
    agent("019f-b", "Yielduck · Developer"),
    agent("019f-c", "Dotconfig · Maintainer"),
  ]
  assert.equal(
    identifiedAgentLabel(agents[0]!, agents),
    "Yielduck · Developer · Instance 1",
  )
  assert.equal(
    identifiedAgentLabel(agents[1]!, agents),
    "Yielduck · Developer · Instance 2",
  )
  assert.equal(
    identifiedAgentLabel(agents[2]!, agents),
    "Dotconfig · Maintainer",
  )
})
