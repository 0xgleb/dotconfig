import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Effect } from "effect"
import { makeSqliteRegistryStore } from "./sqlite-store.ts"

const run = Effect.runPromise

test("schema migration backfills open registry requests into the durable backlog", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-migration-"))
  try {
    const initial = makeSqliteRegistryStore(root)
    await run(
      initial.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Backfill this open request",
        now: 1_000,
      }),
    )
    initial.close()

    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database.exec(`
      DROP TABLE backlog_transitions;
      DROP TABLE backlog_evidence;
      DROP TABLE backlog_requirements;
      DROP TABLE backlog_sources;
      DROP TABLE backlog_items;
      PRAGMA user_version = 4;
    `)
    database.close()

    const migrated = makeSqliteRegistryStore(root)
    const snapshot = await run(migrated.backlogSnapshot("/repo/a"))
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.sources.length, 1)
    assert.equal(snapshot.requirements.length, 1)
    migrated.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("schema migration restores claimed request assignment into the backlog", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-claimed-migration-"))
  try {
    const initial = makeSqliteRegistryStore(root)
    const agent = { id: "agent-1", pid: 123 }
    const lease = await run(
      initial.claim({
        agent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_000,
        ttlMs: 60_000,
      }),
    )
    const request = await run(
      initial.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Restore this claimed assignment",
        now: 2_000,
      }),
    )
    await run(
      initial.claimRequest({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        now: 3_000,
      }),
    )
    initial.close()

    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database.exec(`
      DROP TABLE backlog_transitions;
      DROP TABLE backlog_evidence;
      DROP TABLE backlog_requirements;
      DROP TABLE backlog_sources;
      DROP TABLE backlog_items;
      PRAGMA user_version = 4;
    `)
    database.close()

    const migrated = makeSqliteRegistryStore(root)
    const snapshot = await run(migrated.backlogSnapshot("/repo/a"))
    assert.equal(snapshot.items[0]?.state.kind, "assigned")
    assert.deepEqual(
      snapshot.transitions.map(transition => transition.event),
      ["assign"],
    )
    migrated.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("registry shadow ingestion preserves the full bounded request across requirement chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-long-request-"))
  try {
    const store = makeSqliteRegistryStore(root)
    const text = "x".repeat(8_000)
    await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text,
        now: 1_000,
      }),
    )

    const snapshot = await run(store.backlogSnapshot("/repo/a"))
    assert.deepEqual(
      snapshot.requirements.map(requirement => requirement.text.length),
      [4_000, 4_000],
    )
    assert.equal(
      snapshot.requirements.map(requirement => requirement.text).join(""),
      text,
    )
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("branch todo snapshots preserve requirements and terminalize only previously open work", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-branch-todo-"))
  try {
    const store = makeSqliteRegistryStore(root)
    const canonicalId = "session-1:todo-1"
    await run(
      store.reconcileBranchTodos({
        project: "/repo/a",
        sessionId: "session-1",
        observedAt: 1_000,
        todos: [
          {
            canonicalId,
            sourceId: `${canonicalId}:snapshot-1`,
            requirements: ["Implement it", "Preserve correction"],
            status: "blocked",
            reason: "Waiting for evidence",
          },
          {
            canonicalId: "session-1:todo-2",
            sourceId: "session-1:todo-2:snapshot-1",
            requirements: ["Historical completed work"],
            status: "completed",
          },
        ],
      }),
    )
    const blocked = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(blocked.items.length, 1)
    assert.equal(blocked.items[0]?.state.kind, "blocked")
    assert.deepEqual(
      blocked.requirements.map(requirement => requirement.text),
      ["Implement it", "Preserve correction"],
    )

    await run(
      store.reconcileBranchTodos({
        project: "/repo/a",
        sessionId: "session-1",
        observedAt: 2_000,
        todos: [
          {
            canonicalId,
            sourceId: `${canonicalId}:snapshot-2`,
            requirements: [
              "Implement it",
              "Preserve correction",
              "Final owner requirement",
            ],
            status: "completed",
          },
        ],
      }),
    )
    const completed = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(completed.items[0]?.state.kind, "terminal")
    assert.equal(completed.sources.length, 2)
    assert.equal(completed.requirements.length, 5)

    await run(
      store.reconcileBranchTodos({
        project: "/repo/a",
        sessionId: "session-1",
        observedAt: 3_000,
        todos: [
          {
            canonicalId,
            sourceId: `${canonicalId}:snapshot-3`,
            requirements: [
              "Implement it",
              "Preserve correction",
              "Final owner requirement",
              "Post-completion evidence",
            ],
            status: "completed",
          },
        ],
      }),
    )
    const enrichedTerminal = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(enrichedTerminal.items.length, 1)
    assert.equal(enrichedTerminal.items[0]?.state.kind, "terminal")
    assert.equal(enrichedTerminal.sources.length, 3)
    assert.equal(enrichedTerminal.requirements.length, 9)
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("owner and bridge messages deduplicate without upgrading source-local authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-messages-"))
  try {
    const store = makeSqliteRegistryStore(root)
    await run(
      store.ingestMessage({
        project: "/repo/a",
        messageId: "owner-message-1",
        observedAt: 1_000,
        source: "owner-message",
        authority: "authenticated-owner",
        requirements: ["Preserve this exact routed requirement"],
      }),
    )
    await run(
      store.ingestMessage({
        project: "/repo/a",
        messageId: "bridge-message-1",
        observedAt: 2_000,
        source: "bridge-message",
        authority: "routing-only",
        requirements: ["Preserve this exact routed requirement"],
      }),
    )

    const snapshot = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.sources.length, 2)
    assert.deepEqual(
      snapshot.sources.map(source => source.authority.kind),
      ["authenticated-owner", "routing-only"],
    )
    assert.deepEqual(
      snapshot.requirements.map(requirement => requirement.text),
      [
        "Preserve this exact routed requirement",
        "Preserve this exact routed requirement",
      ],
    )
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("tracker snapshots reconcile lifecycle while retaining owner provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-tracker-"))
  try {
    const store = makeSqliteRegistryStore(root)
    await run(
      store.ingestMessage({
        project: "/repo/a",
        messageId: "owner-message-1",
        observedAt: 1_000,
        source: "owner-message",
        authority: "authenticated-owner",
        requirements: ["Fix the tracked delivery bug"],
      }),
    )
    await run(
      store.reconcileCanonicalBacklog({
        project: "/repo/a",
        source: "tracker-item",
        scopeId: "github:org/repo:issues",
        coverage: "partial",
        observedAt: 2_000,
        items: [
          {
            canonicalId: "issue:7",
            sourceId: "github:org/repo:issues:issue:7:v1",
            requirements: ["Fix the tracked delivery bug"],
            status: "blocked",
            priority: "urgent",
            reason: "Waiting for an upstream contract",
          },
        ],
      }),
    )
    await run(
      store.reconcileCanonicalBacklog({
        project: "/repo/a",
        source: "tracker-item",
        scopeId: "github:org/repo:issues",
        coverage: "partial",
        observedAt: 3_000,
        items: [
          {
            canonicalId: "issue:7",
            sourceId: "github:org/repo:issues:issue:7:v2",
            requirements: ["Preserve the issue acceptance criteria"],
            status: "ready",
            priority: "normal",
          },
        ],
      }),
    )
    await run(
      store.reconcileCanonicalBacklog({
        project: "/repo/a",
        source: "tracker-item",
        scopeId: "github:org/repo:issues",
        coverage: "complete",
        observedAt: 4_000,
        items: [
          {
            canonicalId: "issue:7",
            sourceId: "github:org/repo:issues:issue:7:v3",
            requirements: ["Tracker item closed"],
            status: "completed",
            priority: "normal",
          },
        ],
      }),
    )

    const snapshot = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0]?.state.kind, "terminal")
    assert.equal(snapshot.sources.length, 4)
    assert.deepEqual(
      snapshot.sources.map(source => source.authority.kind),
      ["authenticated-owner", "routing-only", "routing-only", "routing-only"],
    )
    assert.deepEqual(
      snapshot.requirements.map(requirement => requirement.text),
      [
        "Fix the tracked delivery bug",
        "Fix the tracked delivery bug",
        "Preserve the issue acceptance criteria",
        "Tracker item closed",
      ],
    )
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("registry enqueue atomically shadow-ingests exact duplicates into one durable backlog item", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-sqlite-"))
  try {
    const firstStore = makeSqliteRegistryStore(root)
    await run(
      firstStore.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Preserve every requirement",
        priority: "urgent",
        now: 1_000,
      }),
    )
    await run(
      firstStore.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-2",
        text: "Preserve every requirement",
        priority: "normal",
        now: 2_000,
      }),
    )

    const firstSnapshot = await run(firstStore.backlogSnapshot("/repo/a"))
    assert.equal(firstSnapshot.items.length, 1)
    assert.equal(firstSnapshot.sources.length, 2)
    assert.equal(firstSnapshot.requirements.length, 2)
    assert.equal(firstSnapshot.items[0]?.priority, "urgent")
    firstStore.close()

    const reopened = makeSqliteRegistryStore(root)
    const persisted = await run(reopened.backlogSnapshot("/repo/a"))
    assert.equal(persisted.items.length, 1)
    assert.equal(persisted.sources.length, 2)
    reopened.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("same-session host replacement rebinds an active backlog assignment to the new lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-lease-rebind-"))
  const store = makeSqliteRegistryStore(root)
  try {
    const originalAgent = { id: "session-1:pid:123", pid: 123 }
    const replacementAgent = { id: "session-1:pid:456", pid: 456 }
    const firstLease = await run(
      store.claim({
        agent: originalAgent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_000,
        ttlMs: 100,
      }),
    )
    const request = await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Survive an in-place host replacement",
        now: 1_010,
      }),
    )
    await run(
      store.claimRequest({
        requestId: request.id,
        leaseId: firstLease.lease.id,
        agentId: originalAgent.id,
        now: 1_020,
      }),
    )
    await run(
      store.advanceRequestBacklog({
        requestId: request.id,
        leaseId: firstLease.lease.id,
        agentId: originalAgent.id,
        phase: "implementation",
        evidenceRef: "implementation:first-host",
        now: 1_030,
      }),
    )

    const replacementLease = await run(
      store.claim({
        agent: replacementAgent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_200,
        ttlMs: 100,
      }),
    )
    assert.notEqual(replacementLease.lease.id, firstLease.lease.id)
    await run(
      store.claimRequest({
        requestId: request.id,
        leaseId: replacementLease.lease.id,
        agentId: replacementAgent.id,
        now: 1_210,
      }),
    )

    const rebound = await run(store.backlogSnapshot("/repo/a"))
    assert.deepEqual(rebound.items[0]?.state, {
      kind: "implementing",
      agentId: replacementAgent.id,
      leaseId: replacementLease.lease.id,
      implementationRef: "implementation:first-host",
    })
    await run(
      store.advanceRequestBacklog({
        requestId: request.id,
        leaseId: replacementLease.lease.id,
        agentId: replacementAgent.id,
        phase: "review",
        evidenceRef: "review:replacement-host",
        now: 1_220,
      }),
    )
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("registry claim and completion advance the linked backlog with terminal evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-lifecycle-"))
  try {
    const store = makeSqliteRegistryStore(root)
    const agent = { id: "agent-1", pid: 123 }
    const lease = await run(
      store.claim({
        agent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_000,
        ttlMs: 60_000,
      }),
    )
    const request = await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Implement and prove it",
        now: 2_000,
      }),
    )
    await run(
      store.claimRequest({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        now: 3_000,
      }),
    )
    const assigned = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(assigned.items[0]?.state.kind, "assigned")

    await run(
      store.completeRequest({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        summary: "Implemented and verified",
        now: 4_000,
      }),
    )
    const completed = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(completed.items[0]?.state.kind, "terminal")
    const terminal = completed.items[0]?.state
    assert.equal(
      terminal?.kind === "terminal" ? terminal.outcome : undefined,
      "completed",
    )
    assert.deepEqual(
      terminal?.kind === "terminal" ? terminal.evidence : undefined,
      [
        { kind: "registry-outcome", ref: request.id },
        { kind: "implementation-summary", ref: request.id },
      ],
    )
    assert.deepEqual(
      completed.transitions.map(transition => transition.event),
      ["assign", "start", "complete"],
    )
    assert.deepEqual(
      completed.evidence.map(record => [record.phase, record.kind, record.ref]),
      [
        ["implementation", "implementation-reference", request.id],
        ["terminal", "registry-outcome", request.id],
        ["terminal", "implementation-summary", request.id],
      ],
    )
    store.close()

    const reopened = makeSqliteRegistryStore(root)
    const persisted = await run(reopened.backlogSnapshot("/repo/a"))
    assert.deepEqual(
      persisted.transitions.map(transition => transition.event),
      ["assign", "start", "complete"],
    )
    assert.equal(persisted.evidence.length, 3)
    reopened.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("deduplicated request completions retain terminal evidence from every source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-terminal-evidence-"))
  try {
    const store = makeSqliteRegistryStore(root)
    const agent = { id: "agent-1", pid: 123 }
    const lease = await run(
      store.claim({
        agent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_000,
        ttlMs: 60_000,
      }),
    )
    const requests = await Promise.all(
      [2_000, 3_000].map(now =>
        run(
          store.enqueue({
            project: "/repo/a",
            role: "worker",
            requesterId: `requester-${now}`,
            text: "One exact logical requirement",
            now,
          }),
        ),
      ),
    )
    for (const [index, request] of requests.entries()) {
      await run(
        store.claimRequest({
          requestId: request.id,
          leaseId: lease.lease.id,
          agentId: agent.id,
          now: 4_000 + index * 2,
        }),
      )
      await run(
        store.completeRequest({
          requestId: request.id,
          leaseId: lease.lease.id,
          agentId: agent.id,
          summary: `Completed source ${index + 1}`,
          now: 5_000 + index * 2,
        }),
      )
    }

    const snapshot = await run(store.backlogSnapshot("/repo/a"))
    const terminal = snapshot.items[0]?.state
    assert.equal(terminal?.kind, "terminal")
    assert.equal(
      terminal?.kind === "terminal" ? terminal.evidence.length : 0,
      4,
    )
    assert.equal(snapshot.evidence.length, 5)
    assert.deepEqual(
      snapshot.evidence.map(record => [record.phase, record.kind]),
      [
        ["implementation", "implementation-reference"],
        ["terminal", "registry-outcome"],
        ["terminal", "implementation-summary"],
        ["terminal", "registry-outcome"],
        ["terminal", "implementation-summary"],
      ],
    )
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a completed duplicate cannot rewrite a cancelled terminal item", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-cancelled-terminal-"))
  try {
    const store = makeSqliteRegistryStore(root)
    const agent = { id: "agent-1", pid: 123 }
    const lease = await run(
      store.claim({
        agent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_000,
        ttlMs: 60_000,
      }),
    )
    const first = await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "One cancelled logical requirement",
        now: 2_000,
      }),
    )
    const second = await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-2",
        text: "One cancelled logical requirement",
        now: 3_000,
      }),
    )
    await run(
      store.cancelRequest({
        requestId: first.id,
        requesterId: first.requesterId,
        now: 4_000,
      }),
    )
    await run(
      store.claimRequest({
        requestId: second.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        now: 5_000,
      }),
    )
    await assert.rejects(
      run(
        store.completeRequest({
          requestId: second.id,
          leaseId: lease.lease.id,
          agentId: agent.id,
          summary: "Must not fabricate completion",
          now: 6_000,
        }),
      ),
      /cancelled backlog item cannot be completed/i,
    )
    const snapshot = await run(store.backlogSnapshot("/repo/a"))
    assert.equal(snapshot.items[0]?.state.kind, "terminal")
    if (snapshot.items[0]?.state.kind === "terminal")
      assert.equal(snapshot.items[0].state.outcome, "cancelled")
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("request phase transitions preserve implementation, review, and publication evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-phases-"))
  try {
    const store = makeSqliteRegistryStore(root)
    const agent = { id: "agent-1", pid: 123 }
    const lease = await run(
      store.claim({
        agent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_000,
        ttlMs: 60_000,
      }),
    )
    const request = await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Implement, review, and publish it",
        now: 2_000,
      }),
    )
    await run(
      store.claimRequest({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        now: 3_000,
      }),
    )
    await run(
      store.advanceRequestBacklog({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        phase: "implementation",
        evidenceRef: "commit:abc123",
        now: 4_000,
      }),
    )
    await run(
      store.advanceRequestBacklog({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        phase: "review",
        evidenceRef: "workflow:wf-7",
        now: 5_000,
      }),
    )
    await run(
      store.advanceRequestBacklog({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        phase: "publication",
        evidenceRef: "pr:42",
        now: 6_000,
      }),
    )
    await run(
      store.completeRequest({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        summary: "Published and independently verified",
        now: 7_000,
      }),
    )

    const snapshot = await run(store.backlogSnapshot("/repo/a"))
    assert.deepEqual(
      snapshot.transitions.map(transition => transition.event),
      ["assign", "start", "review", "publish", "complete"],
    )
    assert.deepEqual(
      snapshot.evidence.map(record => [record.phase, record.ref]),
      [
        ["implementation", "commit:abc123"],
        ["review", "workflow:wf-7"],
        ["publication", "pr:42"],
        ["terminal", request.id],
        ["terminal", request.id],
      ],
    )
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("administrative registry clear preserves only the selected project backlog", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-clear-"))
  try {
    const store = makeSqliteRegistryStore(root)
    await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Keep this",
        now: 1_000,
      }),
    )
    await run(
      store.enqueue({
        project: "/repo/b",
        role: "worker",
        requesterId: "requester-2",
        text: "Remove this",
        now: 2_000,
      }),
    )

    await run(
      store.clearExceptProject({ preservedProject: "/repo/a", now: 3_000 }),
    )
    assert.equal((await run(store.backlogSnapshot("/repo/a"))).items.length, 1)
    assert.equal((await run(store.backlogSnapshot("/repo/b"))).items.length, 0)
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("persisted backlog state kind must match its encoded state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-state-kind-"))
  try {
    const initial = makeSqliteRegistryStore(root)
    await run(
      initial.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Reject malformed persisted state",
        now: 1_000,
      }),
    )
    initial.close()

    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database
      .prepare("UPDATE backlog_items SET state_json = ?")
      .run(JSON.stringify({ kind: "blocked", reason: "forged" }))
    database.close()

    const reopened = makeSqliteRegistryStore(root)
    await assert.rejects(
      run(reopened.backlogSnapshot("/repo/a")),
      /state kind does not match/i,
    )
    reopened.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("persisted backlog state rejects unknown fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-state-fields-"))
  try {
    const initial = makeSqliteRegistryStore(root)
    await run(
      initial.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Reject unknown persisted state fields",
        now: 1_000,
      }),
    )
    initial.close()
    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database
      .prepare("UPDATE backlog_items SET state_json = ?")
      .run(JSON.stringify({ kind: "ready", extra: true }))
    database.close()
    const reopened = makeSqliteRegistryStore(root)
    await assert.rejects(
      run(reopened.backlogSnapshot("/repo/a")),
      /state contains unexpected fields/i,
    )
    reopened.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("terminal item evidence must reconcile with persisted evidence rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-evidence-reconcile-"))
  try {
    const store = makeSqliteRegistryStore(root)
    const agent = { id: "agent-1", pid: 123 }
    const lease = await run(
      store.claim({
        agent,
        project: "/repo/a",
        role: "worker",
        mode: "task",
        policyDigest: "policy-1",
        now: 1_000,
        ttlMs: 60_000,
      }),
    )
    const request = await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Reconcile terminal evidence",
        now: 2_000,
      }),
    )
    await run(
      store.claimRequest({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        now: 3_000,
      }),
    )
    await run(
      store.completeRequest({
        requestId: request.id,
        leaseId: lease.lease.id,
        agentId: agent.id,
        summary: "Done",
        now: 4_000,
      }),
    )
    store.close()

    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database
      .prepare("DELETE FROM backlog_evidence WHERE phase = 'terminal'")
      .run()
    database.close()

    const reopened = makeSqliteRegistryStore(root)
    await assert.rejects(
      run(reopened.backlogSnapshot("/repo/a")),
      /terminal evidence does not reconcile/i,
    )
    reopened.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("persisted backlog fields retain their domain bounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-field-bounds-"))
  try {
    const initial = makeSqliteRegistryStore(root)
    await run(
      initial.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Reject malformed persisted fields",
        now: 1_000,
      }),
    )
    initial.close()

    const database = new DatabaseSync(join(root, "registry.sqlite"))
    database.prepare("UPDATE backlog_items SET dedupe_digest = ''").run()
    database.close()

    const reopened = makeSqliteRegistryStore(root)
    await assert.rejects(
      run(reopened.backlogSnapshot("/repo/a")),
      /dedupe_digest violates its persisted bound/i,
    )
    reopened.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("persisted backlog projects, revisions, and timestamps are canonical", async () => {
  const corruptions = [
    {
      name: "project",
      update: "UPDATE backlog_items SET project = '/repo/a/'",
      read: (store: ReturnType<typeof makeSqliteRegistryStore>) =>
        store.backlogProjects(),
      pattern: /project is not canonical/i,
    },
    {
      name: "revision",
      update: "UPDATE backlog_items SET revision = 0",
      read: (store: ReturnType<typeof makeSqliteRegistryStore>) =>
        store.backlogSnapshot("/repo/a"),
      pattern: /revision or timestamp is malformed/i,
    },
    {
      name: "timestamp",
      update: "UPDATE backlog_items SET updated_at = created_at - 1",
      read: (store: ReturnType<typeof makeSqliteRegistryStore>) =>
        store.backlogSnapshot("/repo/a"),
      pattern: /revision or timestamp is malformed/i,
    },
  ] as const
  for (const corruption of corruptions) {
    const root = mkdtempSync(
      join(tmpdir(), `pi-backlog-${corruption.name}-bound-`),
    )
    try {
      const initial = makeSqliteRegistryStore(root)
      await run(
        initial.enqueue({
          project: "/repo/a",
          role: "worker",
          requesterId: "requester-1",
          text: "Reject malformed persisted metadata",
          now: 1_000,
        }),
      )
      initial.close()
      const database = new DatabaseSync(join(root, "registry.sqlite"))
      database.exec(corruption.update)
      database.close()
      const reopened = makeSqliteRegistryStore(root)
      await assert.rejects(run(corruption.read(reopened)), corruption.pattern)
      reopened.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("backlog snapshots remain project-scoped", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-backlog-project-"))
  try {
    const store = makeSqliteRegistryStore(root)
    await run(
      store.enqueue({
        project: "/repo/a",
        role: "worker",
        requesterId: "requester-1",
        text: "Same text",
        now: 1_000,
      }),
    )
    await run(
      store.enqueue({
        project: "/repo/b",
        role: "worker",
        requesterId: "requester-2",
        text: "Same text",
        now: 2_000,
      }),
    )

    assert.equal((await run(store.backlogSnapshot("/repo/a"))).items.length, 1)
    assert.equal((await run(store.backlogSnapshot("/repo/b"))).items.length, 1)
    store.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
