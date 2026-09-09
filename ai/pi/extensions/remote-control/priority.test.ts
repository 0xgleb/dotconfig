import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("Telegram prompts steer an active local turn at the next safe boundary", () => {
  assert.match(source, /accepting: active === undefined/)
  assert.doesNotMatch(source, /accepting: ctx\.isIdle\(\)/)
  assert.match(
    source,
    /remoteTurnContent\([\s\S]*?message\.text,[\s\S]*?message\.images,[\s\S]*?"conversational",[\s\S]*?sendUserMessage\(content, \{[\s\S]*?deliverAs: "steer"/,
  )
  assert.doesNotMatch(source, /if \(active \|\| !ctx\.isIdle\(\)\) return/)
})

test("only authenticated Telegram ingress records a direct owner intervention", () => {
  assert.match(
    source,
    /import \{ HUMAN_TURN_EVENT \} from "\.\.\/shared\/usage-governor-events\.ts"/,
  )
  assert.match(
    source,
    /const authenticatedOwner = remoteSourceCarriesOwnerAuthority\(source\)[\s\S]*?if \(authenticatedOwner && prompt\?\.type === "text"\)[\s\S]*?pi\.events\.emit\(HUMAN_TURN_EVENT, prompt\.text\)[\s\S]*?pi\.sendUserMessage\(content,/,
  )
})

test("claimed owner and agent messages enter the durable backlog before model delivery", () => {
  assert.match(
    source,
    /import \{[\s\S]*?backlogRequirementsFromText,[\s\S]*?MESSAGE_BACKLOG_EVENT,[\s\S]*?\} from "\.\.\/shared\/backlog-events\.ts"/,
  )
  assert.match(
    source,
    /const authenticatedOwner = remoteSourceCarriesOwnerAuthority\(source\)[\s\S]*?pi\.events\.emit\(MESSAGE_BACKLOG_EVENT, \{[\s\S]*?project: ctx\.cwd,[\s\S]*?messageId: message\.id,[\s\S]*?source: authenticatedOwner \? "owner-message" : "bridge-message"[\s\S]*?requirements: backlogRequirementsFromText\(message\.text\)[\s\S]*?\}\)[\s\S]*?pi\.sendUserMessage\(content,/,
  )
})

test("routing turns never present no-inbox bridge endpoints as live workers", () => {
  assert.match(
    source,
    /store\.listAgents\(Date\.now\(\)\)[\s\S]*?bridgeQueueRoutableAgents\(roster\.right\)\.map\(\(\{ id, label, cwd \}\)/,
  )
})

test("routing turns roster known projects whose receiver holds no live lease", () => {
  assert.match(
    source,
    /pi\.events\.emit\(REGISTRY_PROJECTS_REQUEST_EVENT, request\)/,
  )
  assert.match(source, /setTimeout\(\(\) => resolve\(\[\]\), 3_000\)/)
  assert.match(
    source,
    /const known = await knownProjects\(\)[\s\S]*?const offline[\s\S]*?= known[\s\S]*?!live\.some\(\(\{ cwd \}\) => coversProject\(cwd, project\)\)/,
  )
  assert.match(
    source,
    /id: "queue",\s*label: "receiver offline - queued for its next poll",\s*cwd: project,/,
  )
  assert.match(
    source,
    /routingBatchPrompt\([\s\S]*?\[\.\.\.live, \.\.\.offline\],/,
  )
})

test("owner-relay frames terminate as delivery or typed dead-letter before routing", () => {
  assert.match(
    source,
    /const relay = parseOwnerRelay\(message\.text\)[\s\S]*?relay\.frame === "malformed-owner-relay"[\s\S]*?malformedOwnerRelayCompletion\(relay\.reason\)[\s\S]*?deliverOwnerRelay\(relay\.body, message\.requesterId\)[\s\S]*?store\.complete\(\{/,
  )
  assert.match(
    source,
    /Either\.isLeft\(sent\)[\s\S]*?outcome: "undelivered",[\s\S]*?outcome: "delivered"/,
  )
  assert.match(source, /ownerRelayCompletion\(relay\.body, delivery\)/)
  assert.doesNotMatch(source, /response: relay,/)
  assert.doesNotMatch(source, /Relayed to owner on Telegram/)
})

test("owner pane input on the dispatch lane is enqueued instead of answered freehand", () => {
  assert.match(
    source,
    /pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?event\.source !== "interactive"/,
  )
  assert.match(
    source,
    /pi\.on\("input"[\s\S]*?store\.enqueue\(\{[\s\S]*?requesterId: "owner-pane",[\s\S]*?ttlMs: BRIDGE_MESSAGE_TTL_MS,[\s\S]*?\}\),[\s\S]*?return \{ action: "handled" \}/,
  )
  assert.match(
    source,
    /pi\.on\("input"[\s\S]*?text\.startsWith\("\/"\)\)[\s\S]*?return \{ action: "continue" \}/,
  )
})
