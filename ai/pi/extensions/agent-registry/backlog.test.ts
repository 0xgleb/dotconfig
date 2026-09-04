import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  backlogProjection,
  emptyBacklogState,
  externalBacklogProjection,
  ingestBacklogSource,
  transitionBacklogItem,
  type BacklogState,
  type IngestBacklogSourceInput,
} from "./backlog.ts"

const request = (
  id: string,
  text: string,
  project = "/repo/a",
  authority: IngestBacklogSourceInput["authority"] = {
    kind: "routing-only",
  },
): IngestBacklogSourceInput => ({
  newItemId: `item-${id}`,
  project,
  source: { kind: "registry-request", id },
  observedAt: 1_000,
  priority: "urgent",
  requirements: [{ text }],
  authority,
  dedupe: { kind: "exact-content" },
  initialState: "ready",
})

const ingest = async (
  state: BacklogState,
  input: IngestBacklogSourceInput,
): Promise<BacklogState> =>
  (await Effect.runPromise(ingestBacklogSource(state, input))).state

test("identical requests share one item while retaining both provenances and requirements", async () => {
  const first = await ingest(
    emptyBacklogState,
    request("request-1", "Preserve every exact requirement"),
  )
  const second = await ingest(
    first,
    request("request-2", "Preserve every exact requirement"),
  )

  assert.equal(second.items.length, 1)
  assert.equal(second.sources.length, 2)
  assert.equal(second.requirements.length, 2)
  assert.deepEqual(
    second.sources.map(source => source.id),
    ["request-1", "request-2"],
  )
})

test("canonical tracker provenance joins an identical owner request and remains attachable", async () => {
  const owner = await ingest(
    emptyBacklogState,
    request("owner-1", "Fix the tracked delivery bug", "/repo/a", {
      kind: "authenticated-owner",
      ref: "owner-1",
    }),
  )
  const tracker = await ingest(owner, {
    ...request("tracker-1", "Fix the tracked delivery bug"),
    source: { kind: "tracker-item", id: "github:org/repo:issue:7:v1" },
    dedupe: { kind: "canonical-key", key: "github:org/repo:issue:7" },
  })
  const trackerItem = tracker.items[0]
  assert.ok(trackerItem)
  const updated = await ingest(tracker, {
    ...request("tracker-2", "Preserve the issue acceptance criteria"),
    source: { kind: "tracker-item", id: "github:org/repo:issue:7:v2" },
    dedupe: { kind: "item-id", itemId: trackerItem.id },
  })

  assert.equal(updated.items.length, 1)
  assert.equal(updated.sources.length, 3)
  assert.deepEqual(
    updated.requirements.map(requirement => requirement.text),
    [
      "Fix the tracked delivery bug",
      "Fix the tracked delivery bug",
      "Preserve the issue acceptance criteria",
    ],
  )
})

test("canonical source snapshots preserve new requirements on one logical item", async () => {
  const first = await ingest(emptyBacklogState, {
    ...request("todo-snapshot-1", "Implement the adapter"),
    source: { kind: "branch-todo", id: "session-1:todo-1:snapshot-1" },
    dedupe: { kind: "canonical-key", key: "session-1:todo-1" },
  })
  const second = await ingest(first, {
    ...request("todo-snapshot-2", "Implement the adapter"),
    source: { kind: "branch-todo", id: "session-1:todo-1:snapshot-2" },
    requirements: [
      { text: "Implement the adapter" },
      { text: "Preserve the owner correction" },
    ],
    dedupe: { kind: "canonical-key", key: "session-1:todo-1" },
  })

  assert.equal(second.items.length, 1)
  assert.equal(second.sources.length, 2)
  assert.deepEqual(
    second.requirements.map(requirement => requirement.text),
    [
      "Implement the adapter",
      "Implement the adapter",
      "Preserve the owner correction",
    ],
  )
})

test("external projection excludes branch-only todo items without hiding registry work", async () => {
  const branch = await ingest(emptyBacklogState, {
    ...request("todo-snapshot-1", "Local work"),
    source: { kind: "branch-todo", id: "session-1:todo-1:snapshot-1" },
    dedupe: { kind: "canonical-key", key: "session-1:todo-1" },
  })
  const mixed = await ingest(
    branch,
    request("request-1", "External routed work"),
  )

  assert.equal(
    (await Effect.runPromise(backlogProjection(mixed, "/repo/a"))).totalOpen,
    2,
  )
  assert.equal(
    (await Effect.runPromise(externalBacklogProjection(mixed, "/repo/a")))
      .totalOpen,
    1,
  )
})

test("same content in different projects never deduplicates", async () => {
  const first = await ingest(emptyBacklogState, request("request-1", "Fix it"))
  const second = await ingest(first, request("request-2", "Fix it", "/repo/b"))

  assert.equal(second.items.length, 2)
})

test("a source identity cannot alias an item from another project", async () => {
  const first = await ingest(emptyBacklogState, request("request-1", "Fix it"))
  const conflicting = await Effect.runPromise(
    Effect.either(
      ingestBacklogSource(first, request("request-1", "Fix it", "/repo/b")),
    ),
  )

  assert.equal(Either.isLeft(conflicting), true)
  if (Either.isLeft(conflicting))
    assert.equal(conflicting.left.code, "source_conflict")
})

test("exact-content dedupe scope separates identical role requirements", async () => {
  const first = await ingest(emptyBacklogState, {
    ...request("request-1", "Run the same operation"),
    dedupe: { kind: "exact-content", scope: "operator" },
  })
  const second = await ingest(first, {
    ...request("request-2", "Run the same operation"),
    dedupe: { kind: "exact-content", scope: "reviewer" },
  })

  assert.equal(second.items.length, 2)
})

test("deduplication preserves source-local authority instead of upgrading routed text", async () => {
  const first = await ingest(
    emptyBacklogState,
    request("request-1", "Ship the bounded fix"),
  )
  const second = await ingest(
    first,
    request("request-2", "Ship the bounded fix", "/repo/a", {
      kind: "authenticated-owner",
      ref: "telegram:update-7",
    }),
  )

  assert.deepEqual(
    second.sources.map(source => source.authority.kind),
    ["routing-only", "authenticated-owner"],
  )
  assert.equal(second.requirements[0]?.sourceId, "request-1")
  assert.equal(second.requirements[1]?.sourceId, "request-2")
})

test("non-identical requests remain separate instead of semantic auto-merge", async () => {
  const first = await ingest(
    emptyBacklogState,
    request("request-1", "Fix Telegram delivery"),
  )
  const second = await ingest(
    first,
    request("request-2", "Fix Telegram delivery and formatting"),
  )

  assert.equal(second.items.length, 2)
})

test("typed work advances through implementation, review, publication, and terminal evidence", async () => {
  const state = await ingest(emptyBacklogState, request("request-1", "Fix it"))
  const initial = state.items[0]
  assert.ok(initial)

  const assigned = await Effect.runPromise(
    transitionBacklogItem(state, {
      itemId: initial.id,
      expectedRevision: initial.revision,
      actor: "agent-1",
      now: 2_000,
      event: { kind: "assign", agentId: "agent-1", leaseId: "lease-1" },
    }),
  )
  const implementing = await Effect.runPromise(
    transitionBacklogItem(assigned.state, {
      itemId: initial.id,
      expectedRevision: assigned.item.revision,
      actor: "agent-1",
      now: 3_000,
      event: { kind: "start", implementationRef: "commit:abc123" },
    }),
  )
  const reviewing = await Effect.runPromise(
    transitionBacklogItem(implementing.state, {
      itemId: initial.id,
      expectedRevision: implementing.item.revision,
      actor: "agent-1",
      now: 4_000,
      event: { kind: "review", reviewRef: "workflow:wf-7" },
    }),
  )
  const publishing = await Effect.runPromise(
    transitionBacklogItem(reviewing.state, {
      itemId: initial.id,
      expectedRevision: reviewing.item.revision,
      actor: "agent-1",
      now: 5_000,
      event: { kind: "publish", publicationRef: "pr:42" },
    }),
  )
  const completed = await Effect.runPromise(
    transitionBacklogItem(publishing.state, {
      itemId: initial.id,
      expectedRevision: publishing.item.revision,
      actor: "agent-1",
      now: 6_000,
      event: {
        kind: "complete",
        evidence: [{ kind: "registry-outcome", ref: "request-1" }],
      },
    }),
  )

  assert.equal(completed.item.state.kind, "terminal")
  assert.deepEqual(
    completed.state.transitions.map(transition => transition.event),
    ["assign", "start", "review", "publish", "complete"],
  )
  assert.deepEqual(
    completed.state.evidence.map(record => [record.phase, record.ref]),
    [
      ["implementation", "commit:abc123"],
      ["review", "workflow:wf-7"],
      ["publication", "pr:42"],
      ["terminal", "request-1"],
    ],
  )
})

test("generic backlog transitions cannot forge a verified lease rebind", async () => {
  const state = await ingest(emptyBacklogState, request("request-1", "Fix it"))
  const initial = state.items[0]
  assert.ok(initial)
  const assigned = await Effect.runPromise(
    transitionBacklogItem(state, {
      itemId: initial.id,
      expectedRevision: initial.revision,
      actor: "session-1:pid:123",
      now: 2_000,
      event: {
        kind: "assign",
        agentId: "session-1:pid:123",
        leaseId: "lease-1",
      },
    }),
  )
  const forged = await Effect.runPromise(
    Effect.either(
      transitionBacklogItem(assigned.state, {
        itemId: initial.id,
        expectedRevision: assigned.item.revision,
        actor: "agent-registry",
        now: 3_000,
        event: {
          kind: "rebind",
          agentId: "session-1:pid:456",
          leaseId: "lease-2",
        } as never,
      }),
    ),
  )
  assert.equal(Either.isLeft(forged), true)
  if (Either.isLeft(forged)) assert.equal(forged.left.code, "invalid_input")
})

test("terminal completion requires implementation and evidence while stale revisions cannot overwrite state", async () => {
  const state = await ingest(emptyBacklogState, request("request-1", "Fix it"))
  const item = state.items[0]
  assert.ok(item)

  const withoutImplementation = await Effect.runPromise(
    Effect.either(
      transitionBacklogItem(state, {
        itemId: item.id,
        expectedRevision: item.revision,
        actor: "agent-1",
        now: 2_000,
        event: {
          kind: "complete",
          evidence: [{ kind: "registry-outcome", ref: "request-1" }],
        },
      }),
    ),
  )
  assert.equal(Either.isLeft(withoutImplementation), true)
  if (Either.isLeft(withoutImplementation))
    assert.equal(withoutImplementation.left.code, "invalid_transition")

  const assigned = await Effect.runPromise(
    transitionBacklogItem(state, {
      itemId: item.id,
      expectedRevision: item.revision,
      actor: "agent-1",
      now: 2_000,
      event: { kind: "assign", agentId: "agent-1", leaseId: "lease-1" },
    }),
  )
  const implementing = await Effect.runPromise(
    transitionBacklogItem(assigned.state, {
      itemId: item.id,
      expectedRevision: assigned.item.revision,
      actor: "agent-1",
      now: 3_000,
      event: { kind: "start", implementationRef: "commit:abc123" },
    }),
  )
  const withoutEvidence = await Effect.runPromise(
    Effect.either(
      transitionBacklogItem(implementing.state, {
        itemId: item.id,
        expectedRevision: implementing.item.revision,
        actor: "agent-1",
        now: 4_000,
        event: { kind: "complete", evidence: [] },
      }),
    ),
  )
  assert.equal(Either.isLeft(withoutEvidence), true)
  if (Either.isLeft(withoutEvidence))
    assert.equal(withoutEvidence.left.code, "missing_evidence")

  const stale = await Effect.runPromise(
    Effect.either(
      transitionBacklogItem(assigned.state, {
        itemId: item.id,
        expectedRevision: item.revision,
        actor: "agent-2",
        now: 3_000,
        event: { kind: "block", reason: "stale" },
      }),
    ),
  )
  assert.equal(Either.isLeft(stale), true)
  if (Either.isLeft(stale)) assert.equal(stale.left.code, "stale_revision")
})

test("protective path references remain requirements without granting file access", async () => {
  const state = await ingest(
    emptyBacklogState,
    request(
      "request-1",
      "Preserve .env and private-key.age without reading them",
    ),
  )
  assert.equal(state.requirements[0]?.text.includes(".env"), true)
})

test("malformed ingestion discriminants fail before persistence", async () => {
  const cases: readonly [
    label: string,
    mutate: (input: IngestBacklogSourceInput) => void,
  ][] = [
    ["source kind", input => void Reflect.set(input.source, "kind", "forged")],
    ["priority", input => void Reflect.set(input, "priority", "forged")],
    [
      "initial state",
      input => void Reflect.set(input, "initialState", "forged"),
    ],
    [
      "authority kind",
      input => void Reflect.set(input.authority, "kind", "forged"),
    ],
    ["dedupe kind", input => void Reflect.set(input.dedupe, "kind", "forged")],
  ]

  for (const [label, mutate] of cases) {
    const input = request(`request-${label.replaceAll(" ", "-")}`, "Fix it")
    mutate(input)
    const result = await Effect.runPromise(
      Effect.either(ingestBacklogSource(emptyBacklogState, input)),
    )
    assert.equal(Either.isLeft(result), true, label)
    if (Either.isLeft(result))
      assert.equal(result.left.code, "invalid_input", label)
  }
})

test("malformed work text fails before persistence", async () => {
  const result = await Effect.runPromise(
    Effect.either(
      ingestBacklogSource(
        emptyBacklogState,
        request("request-1", "unsafe\u0000requirement"),
      ),
    ),
  )

  assert.equal(Either.isLeft(result), true)
  if (Either.isLeft(result)) assert.equal(result.left.code, "invalid_input")
})

test("project projection exposes external actionable work", async () => {
  const state = await ingest(emptyBacklogState, request("request-1", "Fix it"))

  assert.deepEqual(
    await Effect.runPromise(backlogProjection(state, "/repo/a")),
    {
      actionable: 1,
      blocked: 0,
      unreconciled: 0,
      totalOpen: 1,
    },
  )
  assert.deepEqual(
    await Effect.runPromise(backlogProjection(state, "/repo/b")),
    {
      actionable: 0,
      blocked: 0,
      unreconciled: 0,
      totalOpen: 0,
    },
  )
})
