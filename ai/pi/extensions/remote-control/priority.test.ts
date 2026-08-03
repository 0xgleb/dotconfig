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
