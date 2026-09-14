import assert from "node:assert/strict"
import test from "node:test"
import {
  backlogRequirementsFromText,
  decodeBranchTodoBacklogSnapshot,
  decodeCanonicalBacklogSnapshot,
  decodeExternalBacklogProjection,
  decodeMessageBacklogRecord,
} from "./backlog-events.ts"

const valid = {
  project: "/repo/a",
  actionable: 2,
  blocked: 1,
  unreconciled: 1,
  totalOpen: 4,
  unreconciledSources: ["owner-message", "tracker-item"],
  observedAt: 1_000,
}

test("branch todo backlog snapshot preserves bounded source requirements and lifecycle state", () => {
  const snapshot = {
    project: "/repo/a",
    sessionId: "session-1",
    observedAt: 1_000,
    todos: [
      {
        canonicalId: "session-1:todo-1",
        sourceId: "session-1:todo-1:snapshot-1",
        requirements: ["Implement it", "Owner correction"],
        status: "blocked",
        reason: "Waiting for evidence",
      },
    ],
  }
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(snapshot), snapshot)
  assert.equal(
    decodeBranchTodoBacklogSnapshot({
      ...snapshot,
      todos: [{ ...snapshot.todos[0], requirements: ["x".repeat(4_001)] }],
    }),
    undefined,
  )
  assert.equal(
    decodeBranchTodoBacklogSnapshot({
      ...snapshot,
      project: "/repo/../repo",
    }),
    undefined,
  )
  assert.equal(
    decodeBranchTodoBacklogSnapshot({
      ...snapshot,
      todos: [
        snapshot.todos[0],
        { ...snapshot.todos[0], sourceId: "session-1:todo-1:snapshot-2" },
      ],
    }),
    undefined,
  )
})

test("branch todo pages require complete, consistent groups without changing task identity", () => {
  const page = (index: number, count = 2) => ({
    canonicalId: "session-1:todo-1",
    sourceId: `session-1:todo-1:page-${index}:snapshot-${index}`,
    requirements: [`Requirement ${index}`],
    status: "blocked" as const,
    reason: "Waiting for evidence",
    page: { index, count },
  })
  const snapshot = {
    project: "/repo/a",
    sessionId: "session-1",
    observedAt: 1_000,
    todos: [page(0), page(1)],
  }
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(snapshot), snapshot)
  const single = { ...snapshot, todos: [page(0, 1)] }
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(single), single)
  const reversed = { ...snapshot, todos: [...snapshot.todos].reverse() }
  assert.deepEqual(decodeBranchTodoBacklogSnapshot(reversed), reversed)

  const { page: _page, ...legacy } = page(1)
  const invalidGroups = [
    [page(0)],
    [page(0), page(1, 3)],
    [page(0), { ...page(1), page: { index: 0, count: 2 } }],
    [page(0), { ...page(1), page: { index: 2, count: 2 } }],
    [page(0), legacy],
    [page(0), { ...page(1), sourceId: page(0).sourceId }],
    [page(0), { ...page(1), reason: "Different blocker" }],
    [page(0), { ...page(1), status: "pending", reason: undefined }],
    [
      page(0),
      {
        ...page(1),
        canonicalId: "session-1:todo-2",
        sourceId: "session-1:todo-2:page-1",
      },
    ],
    [page(-1, 1)],
    [page(0, 0)],
    [page(0, 5_001)],
    [page(0.5, 1)],
    [page(0, Number.NaN)],
    [{ ...page(0, 1), page: null }],
    [{ ...page(0, 1), page: undefined }],
    [{ ...page(0, 1), page: { index: "0", count: 1 } }],
  ]
  for (const todos of invalidGroups) {
    assert.equal(
      decodeBranchTodoBacklogSnapshot({ ...snapshot, todos }),
      undefined,
    )
  }
})

test("branch todo validation rejects sparse records and requirements", () => {
  const snapshot = {
    project: "/repo/a",
    sessionId: "session-1",
    observedAt: 1_000,
  }
  assert.equal(
    decodeBranchTodoBacklogSnapshot({
      ...snapshot,
      todos: new Array<unknown>(1),
    }),
    undefined,
  )
  assert.equal(
    decodeBranchTodoBacklogSnapshot({
      ...snapshot,
      todos: [
        {
          canonicalId: "session-1:todo-1",
          sourceId: "session-1:todo-1:v1",
          status: "pending",
          requirements: new Array<unknown>(1),
        },
      ],
    }),
    undefined,
  )
})

test("canonical tracker and backlog-document snapshots preserve lifecycle evidence", () => {
  const tracker = decodeCanonicalBacklogSnapshot({
    project: "/repo/a",
    source: "tracker-item",
    scopeId: "github:org/repo:issues",
    coverage: "complete",
    observedAt: 2_000,
    items: [
      {
        canonicalId: "issue:7",
        sourceId: "github:org/repo:issues:issue:7:v2",
        requirements: ["Fix delivery", "Preserve the acceptance criteria"],
        status: "blocked",
        priority: "urgent",
        reason: "Waiting for an upstream contract",
      },
    ],
  })
  assert.ok(tracker)
  assert.equal(tracker.items[0]?.status, "blocked")

  assert.equal(
    decodeCanonicalBacklogSnapshot({
      ...tracker,
      source: "backlog-document",
      items: [
        {
          ...tracker.items[0],
          sourceId: "wrong-scope:issue:7:v2",
        },
      ],
    }),
    undefined,
  )
  assert.equal(
    decodeCanonicalBacklogSnapshot({
      ...tracker,
      items: [
        tracker.items[0],
        {
          ...tracker.items[0],
          sourceId: "github:org/repo:issues:issue:7:v3",
        },
      ],
    }),
    undefined,
  )
})

test("message requirements page long text without dropping content", () => {
  const text = `${"a".repeat(4_000)}${"b".repeat(4_000)}tail`
  const requirements = backlogRequirementsFromText(text)
  assert.equal(requirements.length, 3)
  assert.equal(requirements.join(""), text)
  assert.deepEqual(backlogRequirementsFromText("   "), [])
  assert.deepEqual(backlogRequirementsFromText("unsafe\u0000text"), [])
})

test("message backlog records preserve authenticated owner and routing-only provenance", () => {
  const owner = {
    project: "/repo/a",
    messageId: "message-1",
    observedAt: 1_000,
    source: "owner-message",
    authority: "authenticated-owner",
    requirements: ["Implement the exact request"],
  }
  assert.deepEqual(decodeMessageBacklogRecord(owner), owner)
  assert.equal(
    decodeMessageBacklogRecord({
      ...owner,
      source: "bridge-message",
      authority: "authenticated-owner",
    }),
    undefined,
  )
  assert.equal(
    decodeMessageBacklogRecord({
      ...owner,
      requirements: ["x".repeat(4_001)],
    }),
    undefined,
  )
})

test("external backlog projection accepts one bounded internally consistent snapshot", () => {
  assert.deepEqual(decodeExternalBacklogProjection(valid), valid)
})

test("external backlog projection rejects forged counts, sources, and stale shapes", () => {
  assert.equal(
    decodeExternalBacklogProjection({ ...valid, actionable: 5 }),
    undefined,
  )
  assert.equal(
    decodeExternalBacklogProjection({
      ...valid,
      unreconciledSources: ["registry-request", "registry-request"],
    }),
    undefined,
  )
  assert.equal(
    decodeExternalBacklogProjection({
      ...valid,
      unreconciledSources: ["credential-store"],
    }),
    undefined,
  )
  assert.equal(
    decodeExternalBacklogProjection({ ...valid, project: "relative" }),
    undefined,
  )
})
