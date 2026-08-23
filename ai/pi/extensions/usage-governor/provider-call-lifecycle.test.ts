import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("./index.ts", import.meta.url), "utf8")

test("unavailable provider admission queues at the request boundary", () => {
  assert.match(source, /pi\.on\("before_provider_request"/u)
  assert.match(source, /awaitProviderCallReservation\(ctx\)/u)
  assert.match(
    source,
    /Either\.isLeft\(reservation\)[\s\S]*usage:provider budget unavailable · call queued[\s\S]*await waitForAdmission\(\)/u,
  )
  assert.match(
    source,
    /!reservation\.right\.allowed[\s\S]*usage:provider queued[\s\S]*await waitForAdmission\(reservation\.right\.retryAt\)/u,
  )
  assert.doesNotMatch(source, /return \{ action: "handled" \}/u)
})

test("every OpenAI provider call reserves and settles typed usage", () => {
  const reservationStart = source.indexOf('pi.on("before_provider_request"')
  const settlementStart = source.indexOf(
    'pi.on("message_end"',
    reservationStart,
  )
  assert.notEqual(reservationStart, -1)
  assert.notEqual(settlementStart, -1)
  const reservationHandler = source.slice(reservationStart, settlementStart)

  assert.match(reservationHandler, /awaitProviderCallReservation\(ctx\)/u)
  assert.doesNotMatch(reservationHandler, /activeTurnLane === "human"/u)
  assert.match(source, /providerCallAction\(/u)
  assert.match(source, /requestProviderCallReservation/u)
  assert.match(source, /event\.message\.usage\.totalTokens/u)
  assert.match(source, /providerCallSettlement\(/u)
  assert.match(source, /settleProviderCallReservation/u)
})

test("provider-call admission waits without aborting the live turn", () => {
  assert.match(
    source,
    /action\.action === "block-unresolved"[\s\S]*usage:provider settlement pending[\s\S]*await waitForAdmission\(\)/u,
  )
  assert.match(
    source,
    /Either\.isLeft\(reservation\)[\s\S]*usage:provider budget unavailable · call queued[\s\S]*await waitForAdmission\(\)/u,
  )
  assert.doesNotMatch(source, /ctx\.abort\(\)/u)
})

test("malformed or unsettled provider usage cannot open another governed call", () => {
  assert.match(
    source,
    /providerCallSettlement\([\s\S]*!pendingSettlement[\s\S]*usage:provider usage malformed · next provider call queued[\s\S]*return/u,
  )
  assert.match(
    source,
    /activeReservation = pendingSettlement[\s\S]*Either\.isLeft\(settlement\)[\s\S]*usage:settlement unavailable · next provider call queued[\s\S]*return/u,
  )
  assert.match(source, /usage:settlement unavailable · provider call queued/u)
  assert.match(source, /activeReservation = undefined/u)
})

test("sample-driven provider reservations replace whole-turn cadence admission", () => {
  const start = source.indexOf('pi.on("before_agent_start"')
  assert.notEqual(start, -1)
  const handler = source.slice(start)
  assert.doesNotMatch(handler, /requestAutonomousAdmission\(/u)
  assert.match(handler, /awaitPreferredModel\(ctx\)/u)
})
