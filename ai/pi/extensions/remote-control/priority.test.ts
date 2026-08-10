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

test("routing turns roster known projects whose receiver holds no live lease", () => {
  assert.match(
    source,
    /pi\.events\.emit\(REGISTRY_PROJECTS_REQUEST_EVENT, request\)/,
  )
  assert.match(source, /setTimeout\(\(\) => resolve\(\[\]\), 3_000\)/)
  assert.match(
    source,
    /const known = await knownProjects\(\);[\s\S]*?const offline[\s\S]*?= known[\s\S]*?!live\.some\(\(\{ cwd \}\) => coversProject\(cwd, project\)\)/,
  )
  assert.match(
    source,
    /id: "queue",\s*label: "receiver offline - queued for its next poll",\s*cwd: project,/,
  )
  assert.match(source, /routingBatchPrompt\([\s\S]*?\[\.\.\.live, \.\.\.offline\],/)
})

test("owner-relay frames reach Telegram before the bridge message completes", () => {
  assert.match(
    source,
    /const relay = parseOwnerRelay\(message\.text\);[\s\S]*?relayToOwner\(authorization\.text\)[\s\S]*?store\.complete\(\{/,
  )
  assert.match(
    source,
    /Either\.isLeft\(sent\)[\s\S]*?outcome: "undelivered",[\s\S]*?outcome: "delivered"/,
  )
  assert.match(source, /response: ownerRelayCompletion\(relay, delivery\),/)
  assert.doesNotMatch(source, /response: relay,/)
  assert.doesNotMatch(source, /Relayed to owner on Telegram/)
})

test("an owner relay is only sent for a sender the live roster answers for", () => {
  assert.match(source, /requesterId: claimed\.right\.requesterId,/)
  assert.match(
    source,
    /const relay = parseOwnerRelay\(message\.text\);[\s\S]*?authorizeOwnerRelay\(\{[\s\S]*?senderId: message\.requesterId,[\s\S]*?dispatcherId: ctx\.sessionManager\.getSessionId\(\),[\s\S]*?roster: roster\.right,/,
  )
  assert.match(
    source,
    /authorization\.outcome === "refused"[\s\S]*?outcome: "undelivered", reason: authorization\.reason/,
  )
  assert.doesNotMatch(
    source,
    /deliverOwnerRelay\(relay\)/,
    "the raw relay body must never reach Telegram unauthorized and unattributed",
  )
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
