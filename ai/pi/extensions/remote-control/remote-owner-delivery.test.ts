import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Effect, Either } from "effect"
import { createModelInputDelivery } from "../../host/model-input-delivery.ts"
import {
  createOwnerAllowance,
  OWNER_ALLOWANCE_MS,
} from "../classified-workflows/owner-allowance.ts"
import {
  RemoteBridgeError,
  remoteMessageSource,
  remoteSourceCarriesOwnerAuthority,
  remoteTurnContent,
} from "./protocol.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const start = source.indexOf("  const beginTurn = async (")
const end = source.indexOf("  /**\n   * Registry leases", start)
assert.ok(start >= 0 && end > start)
const body = stripTypeScriptTypes(source.slice(start, end))

for (const [requesterId, isOwner] of [
  ["telegram-owner-1001", true],
  ["agent-fixture", false],
] as const) {
  test(`actual remote boundary gives delivery provenance only to authenticated owner: ${requesterId}`, async () => {
    let now = 1_000
    let counter = 0
    const guard = createOwnerAllowance({
      now: () => now,
      schedule: () => 0,
      clear: () => {},
      persist: () => {},
      cancel: () => {},
    })
    const ledger = createModelInputDelivery({
      now: () => now,
      newId: () => `input-${++counter}`,
    })
    const registered = ledger.registerGuard("/fixture/main.ts", commit => {
      const result =
        commit.ownerInputIds.length > 0
          ? guard.ownerInput(commit.dispatchedAt)
          : guard.admit()
      return Either.isRight(result)
        ? { action: "allow" }
        : { action: "block", reason: result.left.message }
    })
    assert.ok(registered.ok)
    let queued: object | undefined
    let ingressObservations = 0
    const begin = runInNewContext(`${body}\n;beginTurn`, {
      Effect,
      Either,
      RemoteBridgeError,
      remoteMessageSource,
      remoteSourceCarriesOwnerAuthority,
      remoteTurnContent,
      active: undefined,
      STATUS_KEY: "fixture",
      HUMAN_TURN_EVENT: "fixture:human",
      MESSAGE_BACKLOG_EVENT: "fixture:backlog",
      backlogRequirementsFromText: () => [],
      enterRemoteToolGuard: () => ({}),
      finishFailure: () => assert.fail("fixture input failed before queueing"),
      onAuthenticatedOwnerMessage: () => {
        ingressObservations++
      },
      options: { authorizeOwnerInput: registered.value.authorizeInput },
      pi: {
        registerModelInputDeliveryGuard: () => {},
        events: { emit: () => {} },
        sendUserMessage: (
          content: unknown,
          options: { authorizeInput?: (id: string) => unknown },
        ) => {
          const accepted = ledger.acceptInput("extension")
          assert.ok(accepted.ok)
          options.authorizeInput?.(accepted.value.id)
          queued = { role: "user", content }
          assert.ok(ledger.associate(accepted.value, queued, true).ok)
        },
      },
    })
    await begin(
      {
        status: "claimed",
        id: "bridge-1",
        claimToken: "fixture",
        requesterId,
        images: [],
        createdAt: now,
        text: "Fixture instructions for file.ts",
      },
      {
        cwd: "/fixture",
        ui: { setStatus: () => {} },
      },
    )
    assert.ok(queued)
    assert.equal(
      ingressObservations,
      0,
      "native mode never invokes the legacy receipt-time observer",
    )
    assert.ok(
      Either.isLeft(guard.admit()),
      "receipt/enqueue time must not renew",
    )
    now = 601_000
    let dispatched = false
    const result = ledger.dispatch([queued], () => {
      dispatched = true
    })
    assert.equal(result.ok, isOwner)
    assert.equal(dispatched, isOwner)
    const window = guard.admit()
    assert.equal(Either.isRight(window), isOwner)
    if (Either.isRight(window))
      assert.equal(window.right.deadlineAt, now + OWNER_ALLOWANCE_MS)
    guard.dispose()
  })
}
