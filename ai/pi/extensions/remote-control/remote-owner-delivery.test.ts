import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Effect, Either } from "effect"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { createModelInputDelivery } from "../../host/model-input-delivery.ts"
import {
  createOwnerAllowance,
  OWNER_ALLOWANCE_MS,
} from "../classified-workflows/owner-allowance.ts"
import {
  getManagerBinding,
  registerManagerBinding,
} from "../shared/manager-binding.ts"
import { enterRemoteToolGuard } from "./tool-guard.ts"
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

for (const [requesterId, isOwner, isManager] of [
  ["telegram-owner-1001", true, false],
  ["agent-fixture", false, false],
  ["telegram-owner-1001", true, true],
  ["agent-fixture", false, true],
  ["telegram-forwarded-1001", false, true],
] as const) {
  test(`actual remote boundary: ${requesterId}, manager=${isManager}`, async () => {
    let now = 1000
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
    let activeTools = [
      "agent_registry",
      "todo",
      "manager_control",
      "bash",
      "read",
    ]
    const listeners = new Map<string, ((value: unknown) => void)[]>()
    const pi = {
      registerModelInputDeliveryGuard: () => {},
      getActiveTools: () => [...activeTools],
      setActiveTools: (tools: string[]) => {
        activeTools = [...tools]
      },
      events: {
        on: (name: string, listener: (value: unknown) => void) => {
          listeners.set(name, [...(listeners.get(name) ?? []), listener])
          return () => {}
        },
        emit: (name: string, value: unknown) => {
          for (const listener of listeners.get(name) ?? []) listener(value)
        },
      },
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
    } as unknown as ExtensionAPI
    registerManagerBinding(pi, id =>
      id === "self" && isManager
        ? { role: "manager-unavailable", message: "No worker selected" }
        : undefined,
    )
    const begin = runInNewContext(`${body}\n;beginTurn`, {
      Effect,
      Either,
      RemoteBridgeError,
      remoteMessageSource,
      remoteSourceCarriesOwnerAuthority,
      remoteTurnContent,
      getManagerBinding,
      active: undefined,
      STATUS_KEY: "fixture",
      HUMAN_TURN_EVENT: "fixture:human",
      MESSAGE_BACKLOG_EVENT: "fixture:backlog",
      backlogRequirementsFromText: () => [],
      enterRemoteToolGuard,
      finishFailure: () => assert.fail("fixture input failed before queueing"),
      onAuthenticatedOwnerMessage: () => {
        ingressObservations++
      },
      options: { authorizeOwnerInput: registered.value.authorizeInput },
      pi,
    })
    const ctx = {
      cwd: "/fixture",
      sessionManager: { getSessionId: () => "self", getBranch: () => [] },
      ui: { setStatus: () => {} },
    } as unknown as ExtensionContext
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
      ctx,
    )
    assert.ok(queued)
    assert.deepEqual(
      activeTools,
      isOwner && isManager ? ["agent_registry", "todo", "manager_control"] : [],
    )
    assert.equal(ingressObservations, 0, "native mode never renews at ingress")
    assert.ok(
      Either.isLeft(guard.admit()),
      "receipt/enqueue time must not renew",
    )
    now = 601000
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
