import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import type { RegistryDelegateRequest } from "../shared/registry-intent-events.ts"
import { delegateRejection, enqueueDelegatedRequest } from "./delegate.ts"
import { outcomeEnvelopeRejection, recordRequestOutcome } from "./outcome.ts"
import { managedOperationalRole } from "./paths.ts"
import {
  claimableRequests,
  NOT_ENTITLED_TO_CLOSE,
  reconcileSessionLease,
  RegistryError,
  type AgentIdentity,
  type Lease,
  type RegistryRequest,
  type RegistrySnapshot,
  type RegistryStore,
} from "./registry.ts"
import {
  makeSqliteRegistryStore,
  WITHHELD_OUTCOME_TEXT,
} from "./sqlite-store.ts"

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

const routedRequest = (
  store: RegistryStore,
  assignment: { readonly assignedAgentId?: string },
) =>
  Effect.runPromise(
    store.enqueue({
      project: `${home}/.config`,
      role: "pi-support",
      requesterId: "telegram-dispatch",
      requesterLabel: "Piece of Pi Telegram dispatch",
      requesterCwd: `${home}/.config`,
      text: "fix the reload classifier",
      now: 1_000,
      ...assignment,
    }),
  )

const delegatePayload = (
  overrides: Partial<RegistryDelegateRequest>,
): RegistryDelegateRequest => ({
  project: `${home}/.config`,
  role: "pi-support",
  text: "fix the reload classifier",
  requesterId: "telegram-dispatch",
  requesterLabel: "Piece of Pi Telegram dispatch",
  requesterCwd: `${home}/.config`,
  report: () => {},
  ...overrides,
})

const requestById = async (
  store: RegistryStore,
  requestId: string,
): Promise<RegistryRequest> => {
  const snapshot = await Effect.runPromise(store.snapshot(2_000))
  return (
    snapshot.requests.find(({ id }) => id === requestId) ??
    assert.fail("the enqueued request must still be in the registry")
  )
}

const claimRole = (store: RegistryStore, agent: AgentIdentity) =>
  Effect.runPromise(
    reconcileSessionLease({
      store,
      agent,
      project: `${home}/.config`,
      role: "pi-support",
      mode: "operational",
      policyDigest: "p1",
      now: 1_005,
      ttlMs: 90_000,
    }),
  )

const roleLease = async (
  store: RegistryStore,
  agent: AgentIdentity,
): Promise<Lease> => (await claimRole(store, agent)).lease

const syntheticRequest = (id: string): RegistryRequest => ({
  id,
  project: `${home}/.config`,
  role: "pi-support",
  requesterId: "telegram-dispatch",
  assignedAgentId: "claude-code-config",
  text: "fix the reload classifier",
  createdAt: 1_000,
  updatedAt: 1_000,
  status: "queued",
})

const unreachable = (operation: string) =>
  Effect.fail(
    new RegistryError({
      code: "invalid_input",
      message: `${operation} must not be reached in this test`,
    }),
  )

/**
 * A store that can only be read. Any mutation a workflow attempts fails the
 * test rather than passing silently, which is what makes "closes neither" an
 * assertion instead of a hope.
 */
const readOnlyStore = (requests: readonly RegistryRequest[]): RegistryStore => ({
  snapshot: () =>
    Effect.succeed<RegistrySnapshot>({ version: 1, leases: [], requests }),
  heartbeatAgent: () => unreachable("heartbeatAgent"),
  claim: () => unreachable("claim"),
  heartbeat: () => unreachable("heartbeat"),
  pause: () => unreachable("pause"),
  resume: () => unreachable("resume"),
  release: () => unreachable("release"),
  enqueue: () => unreachable("enqueue"),
  acknowledgeRequest: () => unreachable("acknowledgeRequest"),
  cancelRequest: () => unreachable("cancelRequest"),
  claimRequest: () => unreachable("claimRequest"),
  completeRequest: () => unreachable("completeRequest"),
  failRequest: () => unreachable("failRequest"),
  resolveRequest: () => unreachable("resolveRequest"),
})

/**
 * The real store read through a snapshot taken earlier: the view a session
 * holds when another writer changes the row underneath it.
 */
const withSnapshot = (
  store: RegistryStore,
  snapshot: RegistrySnapshot,
): RegistryStore => ({ ...store, snapshot: () => Effect.succeed(snapshot) })

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

test("the dispatch lane is handed no queue rows to claim", async () => {
  await withStore(async (store) => {
    const lease = await roleLease(store, receiverAgent)
    await Effect.runPromise(
      store.enqueue({
        project: `${home}/.config`,
        role: "pi-support",
        requesterId: "telegram-dispatch",
        requesterLabel: "Piece of Pi Telegram dispatch",
        requesterCwd: `${home}/.config`,
        text: "fix the reload classifier",
        now: 1_010,
      }),
    )
    const snapshot = await Effect.runPromise(store.snapshot(1_020))

    assert.deepEqual(
      claimableRequests({ snapshot, lease, lane: "local-dispatch" }),
      [],
      "the lane routes and records outcomes; claiming hides the row from the receiver that runs it",
    )
    assert.equal(
      claimableRequests({ snapshot, lease, lane: "full-capability" }).length,
      1,
      "an unrouted row is exactly what the session holding the role is there to drain",
    )
  })
})

test("a request routed to another agent is left to that agent", async () => {
  await withStore(async (store) => {
    const lease = await roleLease(store, receiverAgent)
    await routedRequest(store, { assignedAgentId: "claude-code-config" })
    const snapshot = await Effect.runPromise(store.snapshot(1_020))

    assert.deepEqual(
      claimableRequests({ snapshot, lease, lane: "full-capability" }),
      [],
      "the named agent drains it over the bridge; claiming it here runs the same instruction twice",
    )
  })
})

test("routing decides which rows the session holding the role may claim", async () => {
  await withStore(async (store) => {
    const lease = await roleLease(store, receiverAgent)
    const unassigned = await routedRequest(store, {})
    const routedHere = await routedRequest(store, {
      assignedAgentId: receiverAgent.id,
    })
    await routedRequest(store, { assignedAgentId: "claude-code-config" })
    const snapshot = await Effect.runPromise(store.snapshot(1_020))

    assert.deepEqual(
      claimableRequests({ snapshot, lease, lane: "full-capability" })
        .map(({ id }) => id)
        .sort(),
      [unassigned.id, routedHere.id].sort(),
      "an unassigned row belongs to whoever holds the role and a row naming this session is addressed to it; a row naming another agent is neither",
    )
  })
})

test("a row routed to this session's own id is claimed and notified here", async () => {
  await withStore(async (store) => {
    const lease = await roleLease(store, receiverAgent)
    const routedHere = await routedRequest(store, {
      assignedAgentId: receiverAgent.id,
    })
    const snapshot = await Effect.runPromise(store.snapshot(1_020))

    assert.deepEqual(
      claimableRequests({ snapshot, lease, lane: "full-capability" }).map(
        ({ id }) => id,
      ),
      [routedHere.id],
      "a Pi-native receiver registers on the bridge under its registry session id, so this row names the session reading it",
    )

    const claimed = await Effect.runPromise(
      store.claimRequest({
        requestId: routedHere.id,
        leaseId: lease.id,
        agentId: receiverAgent.id,
        now: 1_030,
      }),
    )

    // Sync notifies whatever it just claimed, and notifyRequest re-reads the row
    // and speaks only for a claim held under this lease by this agent. Leaving
    // the row queued for the bridge would fail that gate and deliver nothing.
    assert.deepEqual(
      claimed.status === "claimed"
        ? { leaseId: claimed.leaseId, agentId: claimed.agentId }
        : { leaseId: undefined, agentId: undefined },
      { leaseId: lease.id, agentId: receiverAgent.id },
    )
    assert.match(
      source,
      /for \(const request of claimableRequests\(\{[\s\S]*?store\.claimRequest\(\{[\s\S]*?notificationSent = await notifyRequest\(ctx, claimed\)/,
    )
    assert.match(source, /fresh\.agentId !== identity\(ctx\)\.id/)
  })
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
    /const autoClaimOperationalRole = async \(ctx: ExtensionContext\) => \{\s*if \(sessionLane\(ctx\) === "local-dispatch"\) return undefined/,
  )
  assert.match(source, /claimableRequests\(\{[\s\S]*?lane: sessionLane\(ctx\),/)
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

test("delegating queues the request and takes no role and no row", async () => {
  const delegateBranch = source.slice(
    source.indexOf('request.action === "delegate"'),
    source.indexOf("const requestedRequestId"),
  )
  assert.ok(delegateBranch.length > 0, "the delegate action must still exist")
  assert.doesNotMatch(
    delegateBranch,
    /store\.claim/,
    "delegating decides who should do the work, not that anyone picked it up",
  )

  await withStore(async (store) => {
    const outcome = await Effect.runPromise(
      enqueueDelegatedRequest(store, delegatePayload({}), 1_000),
    )
    assert.equal(outcome.outcome, "queued")

    const snapshot = await Effect.runPromise(store.snapshot(1_010))
    assert.equal(snapshot.leases.length, 0)
    assert.equal(snapshot.requests.length, 1)
    assert.equal(snapshot.requests[0]?.status, "queued")
  })
})

test("the delegate lane records the receiver the routing turn chose", async () => {
  await withStore(async (store) => {
    const queued = await Effect.runPromise(
      enqueueDelegatedRequest(
        store,
        delegatePayload({ assignedAgentId: "claude-code-config" }),
        1_000,
      ),
    )
    const requestId =
      queued.outcome === "queued"
        ? queued.requestId
        : assert.fail(`routing must queue the request: ${queued.reason}`)

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId,
        resolution: "completed",
        summary: "classifier fixed and tested",
        senderId: "claude-code-config",
        now: 1_010,
      }),
    )

    assert.deepEqual(recorded, { outcome: "recorded" })
    const stored = await requestById(store, requestId)
    assert.equal(stored.status, "completed")
    assert.deepEqual(
      stored.status === "completed" ? stored.closedBy : undefined,
      { party: "reporter", agentId: "claude-code-config" },
      "a receiver holding no lease closed it, so the row names the reporter alone",
    )
  })
})

test("a malformed delegate payload is rejected with the field it violated", () => {
  assert.match(
    delegateRejection(delegatePayload({ project: "relative/path" })) ?? "",
    /absolute path/,
  )
  assert.match(
    delegateRejection(delegatePayload({ text: "x".repeat(16_001) })) ?? "",
    /request text/,
  )
  assert.equal(delegateRejection(delegatePayload({})), undefined)
})

test("a malformed outcome envelope is rejected with the field it violated", () => {
  assert.match(
    outcomeEnvelopeRejection({
      requestId: "0a1b",
      resolution: "completed",
      summary: "done",
      senderId: "claude-code-config",
      report: () => {},
    }) ?? "",
    /request id/,
  )
  assert.match(
    outcomeEnvelopeRejection({
      requestId: "0a1b2c3d",
      resolution: "completed",
      summary: "",
      senderId: "claude-code-config",
      report: () => {},
    }) ?? "",
    /summary/,
  )
  assert.equal(
    outcomeEnvelopeRejection({
      requestId: "0a1b2c3d",
      resolution: "completed",
      summary: "done",
      senderId: "claude-code-config",
      report: () => {},
    }),
    undefined,
  )
})

test("the receiver a request was routed to closes it with an outcome envelope", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        // Receivers report the full uuid, but a prefix must resolve to the same
        // row rather than closing a different request or none at all.
        requestId: routed.id.slice(0, 12),
        resolution: "completed",
        summary: "classifier fixed and tested",
        senderId: "claude-code-config",
        now: 1_010,
      }),
    )

    assert.deepEqual(recorded, { outcome: "recorded" })
    const stored = await requestById(store, routed.id)
    assert.equal(stored.status, "completed")
    assert.equal(
      stored.status === "completed" ? stored.summary : undefined,
      "classifier fixed and tested",
    )
  })
})

test("a never-claimed row closes cleanly and reads back with its closing party", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })
    assert.equal(routed.status, "queued")

    await Effect.runPromise(
      store.resolveRequest({
        requestId: routed.id,
        reporterId: "claude-code-config",
        outcome: { resolution: "completed", summary: "done over the bridge" },
        now: 1_010,
      }),
    )

    const stored = await requestById(store, routed.id)
    assert.equal(stored.status, "completed")
    assert.deepEqual(
      stored.status === "completed" ? stored.closedBy : undefined,
      { party: "reporter", agentId: "claude-code-config" },
    )
  })
})

test("a lease holder closing its own claim records the lease it closed under", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {})
    const lease = await roleLease(store, receiverAgent)
    await Effect.runPromise(
      store.claimRequest({
        requestId: routed.id,
        leaseId: lease.id,
        agentId: receiverAgent.id,
        now: 1_008,
      }),
    )

    await Effect.runPromise(
      store.resolveRequest({
        requestId: routed.id,
        reporterId: receiverAgent.id,
        outcome: { resolution: "completed", summary: "drained locally" },
        now: 1_010,
      }),
    )

    const stored = await requestById(store, routed.id)
    assert.deepEqual(
      stored.status === "completed" ? stored.closedBy : undefined,
      { party: "lease_holder", leaseId: lease.id, agentId: receiverAgent.id },
    )
  })
})

test("a failed envelope records the receiver's diagnostic against the routed request", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "failed",
        summary: "blocked on an unreachable host",
        senderId: "claude-code-config",
        now: 1_010,
      }),
    )

    assert.deepEqual(recorded, { outcome: "recorded" })
    const stored = await requestById(store, routed.id)
    assert.equal(stored.status, "failed")
    assert.equal(
      stored.status === "failed" ? stored.diagnostic : undefined,
      "blocked on an unreachable host",
    )
  })
})

test("a diagnostic naming a credential-shaped path still closes the request", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "failed",
        summary: "blocked: deploy.pem is missing",
        senderId: "claude-code-config",
        now: 1_010,
      }),
    )

    // Rejecting the text would wedge the row: the receiver's retry carries the
    // same words and the lease paths filter identically, so nothing could ever
    // close it.
    assert.deepEqual(recorded, { outcome: "recorded" })
    const stored = await requestById(store, routed.id)
    assert.equal(stored.status, "failed")
    assert.equal(
      stored.status === "failed" ? stored.diagnostic : undefined,
      WITHHELD_OUTCOME_TEXT,
    )
  })
})

test("the session holding the role closes a request it was never assigned", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {})
    const claimed = await claimRole(store, receiverAgent)
    assert.equal(claimed.outcome, "claimed")

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "completed",
        summary: "handled by the standing operator",
        senderId: receiverAgent.id,
        now: 1_010,
      }),
    )

    assert.deepEqual(recorded, { outcome: "recorded" })
    assert.equal((await requestById(store, routed.id)).status, "completed")
  })
})

test("an envelope from an unentitled sender leaves the request queued", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })
    // The role holder is a third party here, so neither entitlement branch can
    // admit the sender: closing work it was never given would let any bridge
    // actor retire another agent's row with a summary it invented.
    await claimRole(store, receiverAgent)

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "completed",
        summary: "closing someone else's work",
        senderId: "unrelated-bridge-actor",
        now: 1_010,
      }),
    )

    assert.equal(recorded.outcome, "failed")
    assert.match(
      recorded.outcome === "failed" ? recorded.reason : "",
      /neither the assigned agent nor the holder of the request role/,
    )
    assert.equal((await requestById(store, routed.id)).status, "queued")
  })
})

test("an unentitled sender learns nothing more about a request already closed", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })
    await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "completed",
        summary: "classifier fixed and tested",
        senderId: "claude-code-config",
        now: 1_010,
      }),
    )

    // Answering "recorded" here would acknowledge a close the sender was never
    // party to, and the three distinct answers would map the queue by prefix.
    const probe = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "completed",
        summary: "closing someone else's work",
        senderId: "unrelated-bridge-actor",
        now: 1_020,
      }),
    )

    assert.deepEqual(probe, { outcome: "failed", reason: NOT_ENTITLED_TO_CLOSE })
  })
})

test("the dispatch lane's own registry identity closes nothing", async () => {
  await withStore(async (store) => {
    // The lane relaying the envelope is not a party to the request. If its own
    // session id were entitled, the lane could close rows on its own say-so and
    // would need a lease it is forbidden to hold to do it.
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "completed",
        summary: "relayed by the dispatch lane",
        senderId: dispatchLaneAgent.id,
        now: 1_010,
      }),
    )

    assert.equal(recorded.outcome, "failed")
    const snapshot = await Effect.runPromise(store.snapshot(2_000))
    assert.equal(snapshot.leases.length, 0)
    assert.equal((await requestById(store, routed.id)).status, "queued")
  })
})

test("an envelope with no attributable sender closes nothing", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })

    const recorded = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: routed.id,
        resolution: "completed",
        summary: "anonymous envelope",
        senderId: undefined,
        now: 1_010,
      }),
    )

    assert.equal(recorded.outcome, "failed")
    assert.equal((await requestById(store, routed.id)).status, "queued")
  })
})

test("a re-sent envelope for an already closed request reports it as recorded", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })
    const envelope = {
      requestId: routed.id,
      resolution: "completed",
      summary: "classifier fixed and tested",
      senderId: "claude-code-config",
      now: 1_010,
    } as const

    await Effect.runPromise(recordRequestOutcome(store, envelope))
    const resent = await Effect.runPromise(
      recordRequestOutcome(store, { ...envelope, now: 1_020 }),
    )

    assert.deepEqual(resent, { outcome: "recorded" })
    assert.equal((await requestById(store, routed.id)).status, "completed")
  })
})

test("an envelope that loses the close race is still reported as recorded", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })
    const openSnapshot = await Effect.runPromise(store.snapshot(1_005))
    const envelope = {
      requestId: routed.id,
      resolution: "completed",
      summary: "classifier fixed and tested",
      senderId: "claude-code-config",
      now: 1_010,
    } as const

    await Effect.runPromise(recordRequestOutcome(store, envelope))

    // The retry reads the row before the first close landed, so it walks
    // straight into the store's fenced transition. Losing that race is the
    // reporter getting what it asked for, not a failure to report back.
    const raced = await Effect.runPromise(
      recordRequestOutcome(withSnapshot(store, openSnapshot), {
        ...envelope,
        now: 1_020,
      }),
    )

    assert.deepEqual(raced, { outcome: "recorded" })
    assert.equal((await requestById(store, routed.id)).status, "completed")
  })
})

test("an envelope naming an unknown request closes nothing", async () => {
  await withStore(async (store) => {
    const routed = await routedRequest(store, {
      assignedAgentId: "claude-code-config",
    })

    const unknown = await Effect.runPromise(
      recordRequestOutcome(store, {
        requestId: "00000000-0000-4000-8000-000000000000",
        resolution: "completed",
        summary: "no such request",
        senderId: "claude-code-config",
        now: 1_010,
      }),
    )

    assert.deepEqual(unknown, {
      outcome: "failed",
      reason: "request not found",
    })
    assert.equal((await requestById(store, routed.id)).status, "queued")
  })
})

test("an envelope naming a prefix two requests share closes neither", async () => {
  // Real ids are random uuids, so a shared prefix cannot be provoked through
  // the store: the two colliding rows are supplied directly, and the store this
  // reads through refuses every mutation so a resolved close would fail loudly.
  const colliding: readonly RegistryRequest[] = [
    syntheticRequest("0a1b2c3d-1111-4000-8000-000000000000"),
    syntheticRequest("0a1b2c3d-2222-4000-8000-000000000000"),
  ]

  const ambiguous = await Effect.runPromise(
    recordRequestOutcome(readOnlyStore(colliding), {
      requestId: "0a1b2c3d",
      resolution: "completed",
      summary: "which one?",
      senderId: "claude-code-config",
      now: 1_010,
    }),
  )

  assert.deepEqual(ambiguous, {
    outcome: "failed",
    reason: "request id prefix is ambiguous",
  })
})

