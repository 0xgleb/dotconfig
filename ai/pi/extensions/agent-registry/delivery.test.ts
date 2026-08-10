import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { managedOperationalRole } from "./paths.ts"
import {
  reconcileSessionLease,
  type AgentIdentity,
  type RegistryStore,
} from "./registry.ts"
import { makeSqliteRegistryStore } from "./sqlite-store.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const withStore: (
  exercise: (store: RegistryStore) => Promise<void>,
) => Promise<void> = async (exercise) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-registry-lane-test-"))
  try {
    await exercise(makeSqliteRegistryStore(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const home = "/Users/example"

const dispatchLaneAgent: AgentIdentity = {
  id: "dispatch-lane",
  pid: 101,
  model: "ollama/qwen3.5:9b",
}

const receiverAgent: AgentIdentity = {
  id: "pi-support-receiver",
  pid: 202,
  model: "openai-codex/gpt-5.6-sol",
}

test("terminal request outcomes queue at the next safe boundary while a turn is active", () => {
  assert.match(
    source,
    /for \(const request of notificationsEnabled &&\s*!ctx\.hasPendingMessages\(\) &&\s*!autoReloadPending\(\)/,
  )
  assert.match(
    source,
    /Registry request[\s\S]*?This passive update must not preempt a human prompt[\s\S]*?\{ deliverAs: "followUp" \}/,
  )
})

test("request mutations resolve an exact id or unique prefix to the canonical id", () => {
  assert.match(
    source,
    /id === requestedRequestId \|\| id\.startsWith\(requestedRequestId\)/,
  )
  assert.match(source, /const requestId = target\.id/)
  assert.match(source, /request prefix is ambiguous/)
})

test("the dispatch lane heartbeats fleet presence but never claims queue requests", () => {
  assert.match(
    source,
    /import \{ isLocalDispatchProvider \} from "\.\.\/shared\/local-lane\.ts"/,
  )
  assert.match(
    source,
    /const candidates: readonly RegistryRequest\[\] = isLocalDispatchProvider\(\s*ctx\.model\?\.provider,\s*\)\s*\?\s*\[\]\s*:\s*snapshot\.requests\.filter\(/,
  )
  assert.match(
    source,
    /const candidates: readonly RegistryRequest\[\] = isLocalDispatchProvider[\s\S]*?store\.claimRequest\(\{/,
  )
  assert.match(
    source,
    /store\.heartbeatAgent\(\{[\s\S]*?store\.heartbeat\(\{[\s\S]*?const candidates: readonly RegistryRequest\[\] = isLocalDispatchProvider/,
  )
})

test("the dispatch lane starts on the roster without holding the role that designates the drainer", async () => {
  // index.ts cannot be imported here - typebox and the pi host package are
  // supplied by the running host rather than by node_modules - so the lane's
  // session start is pinned on source and the registry writes it does make are
  // replayed against a real store. The lane runs pinned to ~/.config, which is a
  // managed operational project, and it is the one lane forbidden to drain, so
  // claiming there strands every request delegated to that project.
  const drainerRole =
    managedOperationalRole(`${home}/.config`, home) ??
    assert.fail("the dispatch lane's pinned directory must map to a managed role")
  assert.deepEqual(drainerRole, {
    project: `${home}/.config`,
    role: "pi-support",
  })
  assert.match(
    source,
    /const autoClaimOperationalRole = async \(ctx: ExtensionContext\) => \{\s*if \(isLocalDispatchProvider\(ctx\.model\?\.provider\)\) return undefined/,
  )
  assert.match(
    source,
    /if \(isLocalDispatchProvider\(ctx\.model\?\.provider\)\) return undefined[\s\S]*?reconcileSessionLease\(\{/,
  )
  // Presence is published by sync's agent heartbeat, which no lease gates, so
  // the lane stays addressable for routing after declining the role.
  assert.match(
    source,
    /const sync = async \(ctx: ExtensionContext, notificationsEnabled = true\) => \{[\s\S]*?store\.heartbeatAgent\(\{/,
  )

  await withStore(async (store) => {
    await Effect.runPromise(
      store.heartbeatAgent({
        agent: dispatchLaneAgent,
        cwd: drainerRole.project,
        label: "pi dispatcher",
        now: 1_000,
        ttlMs: 90_000,
      }),
    )
    const afterLaneStart = await Effect.runPromise(store.snapshot(1_001))
    assert.equal(afterLaneStart.leases.length, 0)
    assert.equal(afterLaneStart.agents?.length, 1)
    assert.equal(afterLaneStart.agents?.[0]?.identity.id, dispatchLaneAgent.id)

    const delegated = await Effect.runPromise(
      store.enqueue({
        project: drainerRole.project,
        role: drainerRole.role,
        requesterId: dispatchLaneAgent.id,
        requesterLabel: "pi dispatcher",
        requesterCwd: `${home}/code/example`,
        text: "fix the reload classifier",
        now: 1_010,
      }),
    )

    const receiverClaim = await Effect.runPromise(
      reconcileSessionLease({
        store,
        agent: receiverAgent,
        project: drainerRole.project,
        role: drainerRole.role,
        mode: "operational",
        policyDigest: "p1",
        now: 1_020,
        ttlMs: 90_000,
      }),
    )
    assert.equal(receiverClaim.outcome, "claimed")
    assert.equal(receiverClaim.lease.owner.id, receiverAgent.id)

    const drained = await Effect.runPromise(
      store.claimRequest({
        requestId: delegated.id,
        leaseId: receiverClaim.lease.id,
        agentId: receiverAgent.id,
        now: 1_030,
      }),
    )
    assert.equal(drained.status, "claimed")
  })
})

test("registry outcome handler stores the resolved full id, not the requested prefix", () => {
  assert.match(source, /request\.id\.startsWith\(payload\.requestId\)/)
  assert.match(source, /request id prefix is ambiguous/)
  assert.match(source, /store\.claimRequest\(\{\s*requestId: target\.id,/)
  assert.match(source, /store\.completeRequest\(\{\s*requestId: target\.id,/)
  assert.match(source, /store\.failRequest\(\{\s*requestId: target\.id,/)
})
