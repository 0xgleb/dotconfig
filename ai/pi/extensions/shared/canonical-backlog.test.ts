import assert from "node:assert/strict"
import test from "node:test"
import * as canonical from "./canonical-backlog.ts"
import * as normalizers from "./backlog-normalization.ts"

const snapshot = {
  project: "/repo/a",
  source: "tracker-item",
  scopeId: "github:org/repo",
  coverage: "partial",
  observedAt: 1_000,
  items: [
    {
      canonicalId: "issue:7",
      sourceId: "github:org/repo:issue:7:v1",
      requirements: ["Preserve the contract"],
      status: "blocked",
      priority: "normal",
      reason: "Waiting for evidence",
    },
  ],
}

test("canonical snapshots preserve the existing unversioned scoped representation", () => {
  assert.deepEqual(canonical.decodeCanonicalBacklogSnapshot(snapshot), snapshot)
  const empty = { ...snapshot, items: [] }
  assert.deepEqual(canonical.decodeCanonicalBacklogSnapshot(empty), empty)
  assert.equal(
    canonical.decodeCanonicalBacklogSnapshot(empty)?.coverage,
    "partial",
  )
})

test("canonical snapshots reject malformed identities, coverage and conflicting records", () => {
  for (const value of [
    { ...snapshot, project: "relative" },
    { ...snapshot, project: "/repo/../repo" },
    { ...snapshot, coverage: "unknown" },
    { ...snapshot, source: "owner-message" },
    { ...snapshot, observedAt: -1 },
    {
      ...snapshot,
      items: [{ ...snapshot.items[0], sourceId: "wrong:scope:v1" }],
    },
    {
      ...snapshot,
      items: [{ ...snapshot.items[0], requirements: ["x".repeat(4_001)] }],
    },
    {
      ...snapshot,
      items: [{ ...snapshot.items[0], requirements: ["unsafe\u0000text"] }],
    },
    { ...snapshot, items: [{ ...snapshot.items[0], reason: undefined }] },
    {
      ...snapshot,
      items: [
        snapshot.items[0],
        { ...snapshot.items[0], sourceId: "github:org/repo:issue:7:v2" },
      ],
    },
  ]) {
    assert.equal(canonical.decodeCanonicalBacklogSnapshot(value), undefined)
  }
})

test("requirement splitting preserves bounded text and rejects unsafe content", () => {
  const text = `${"a".repeat(4_000)}${"b".repeat(4_000)}tail`
  const parts = canonical.backlogRequirementsFromText(text)
  assert.equal(parts.length, 3)
  assert.equal(parts.join(""), text)
  assert.deepEqual(canonical.backlogRequirementsFromText("   "), [])
  assert.deepEqual(
    canonical.backlogRequirementsFromText("unsafe\u0000text"),
    [],
  )
})

test("canonical decoder rejects sparse arrays instead of returning invalid typed records", () => {
  assert.equal(
    canonical.decodeCanonicalBacklogSnapshot({
      ...snapshot,
      items: new Array<unknown>(1),
    }),
    undefined,
  )
  assert.equal(
    canonical.decodeCanonicalBacklogSnapshot({
      ...snapshot,
      items: [{ ...snapshot.items[0], requirements: new Array<unknown>(1) }],
    }),
    undefined,
  )
})

test("requirement chunks respect the UTF-16 bound without splitting a surrogate pair", () => {
  const text = "🙂".repeat(2_001)
  const parts = canonical.backlogRequirementsFromText(text)
  assert.equal(parts.join(""), text)
  assert.ok(parts.every(part => part.length <= 4_000))
  assert.deepEqual(parts, ["🙂".repeat(2_000), "🙂"])
})

test("custom iterators cannot hide sparse canonical records or requirements", () => {
  const items = new Array<unknown>(1)
  Object.defineProperty(items, Symbol.iterator, {
    value: () => [snapshot.items[0]][Symbol.iterator](),
  })
  assert.equal(
    canonical.decodeCanonicalBacklogSnapshot({ ...snapshot, items }),
    undefined,
  )
  const requirements = new Array<unknown>(1)
  Object.defineProperty(requirements, Symbol.iterator, {
    value: () => ["Looks valid"][Symbol.iterator](),
  })
  assert.equal(
    canonical.decodeCanonicalBacklogSnapshot({
      ...snapshot,
      items: [{ ...snapshot.items[0], requirements }],
    }),
    undefined,
  )
})

test("canonical validation never invokes supplied array iterators", () => {
  const items = [...snapshot.items]
  const requirements = ["Preserve the contract"]
  const unexpectedIterator = () => {
    throw new Error("iterator must not run")
  }
  Object.defineProperty(items, Symbol.iterator, { value: unexpectedIterator })
  Object.defineProperty(requirements, Symbol.iterator, {
    value: unexpectedIterator,
  })
  assert.doesNotThrow(() => {
    const parsed = canonical.decodeCanonicalBacklogSnapshot({
      ...snapshot,
      items,
    })
    assert.ok(parsed)
    assert.equal(parsed.items, items)
  })
  assert.doesNotThrow(() => {
    const parsed = canonical.decodeCanonicalBacklogSnapshot({
      ...snapshot,
      items: [{ ...snapshot.items[0], requirements }],
    })
    assert.ok(parsed)
    assert.equal(parsed.items[0]?.requirements, requirements)
  })
})

test("supplied map methods cannot forge duplicate-identity validation", () => {
  const items = [
    snapshot.items[0],
    { ...snapshot.items[0], sourceId: "github:org/repo:issue:7:v2" },
  ]
  Object.defineProperty(items, "map", {
    value: () => ["different-1", "different-2"],
  })
  assert.equal(
    canonical.decodeCanonicalBacklogSnapshot({ ...snapshot, items }),
    undefined,
  )
})

test("portable modules export no host or event wiring", () => {
  assert.deepEqual(Object.keys(canonical).sort(), [
    "backlogRequirementsFromText",
    "decodeCanonicalBacklogSnapshot",
  ])
  assert.deepEqual(Object.keys(normalizers).sort(), [
    "BacklogSourceAdapterError",
    "backlogDocumentSnapshot",
    "githubTrackerSnapshot",
  ])
})
