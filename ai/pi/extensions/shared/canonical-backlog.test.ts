import assert from "node:assert/strict"
import { readFileSync, realpathSync } from "node:fs"
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

test("canonical project paths reject NUL values that filesystem APIs cannot represent", () => {
  const value = { ...snapshot, project: "/repo/\u0000" }
  assert.throws(() => realpathSync(value.project), {
    code: "ERR_INVALID_ARG_VALUE",
  })
  assert.equal(canonical.decodeCanonicalBacklogSnapshot(value), undefined)
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

test("requirement splitting rejects non-string runtime values without coercion", () => {
  const coercible = {
    toString: () => {
      throw new Error("coercion must not run")
    },
  }
  for (const value of [null, undefined, 42, Symbol("not text"), coercible])
    assert.deepEqual(
      Reflect.apply(canonical.backlogRequirementsFromText, undefined, [value]),
      [],
    )
})

test("bounded requirement splitting rejects excess chunks without returning partial work", () => {
  assert.deepEqual(
    canonical.backlogRequirementsFromText("x".repeat(128_000), 31),
    [],
  )
  assert.deepEqual(
    canonical.backlogRequirementsFromText(" ".repeat(200_000) + "work", 31),
    ["work"],
  )
  assert.equal(
    canonical.backlogRequirementsFromText("x".repeat(128_000)).length,
    32,
  )
  for (const limit of [-1, NaN, 1.5, Infinity])
    assert.deepEqual(canonical.backlogRequirementsFromText("work", limit), [])
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
    assert.notEqual(parsed.items, items)
    assert.deepEqual(parsed.items[0], snapshot.items[0])
  })
  assert.doesNotThrow(() => {
    const parsed = canonical.decodeCanonicalBacklogSnapshot({
      ...snapshot,
      items: [{ ...snapshot.items[0], requirements }],
    })
    assert.ok(parsed)
    assert.notEqual(parsed.items[0]?.requirements, requirements)
    assert.deepEqual(parsed.items[0]?.requirements, ["Preserve the contract"])
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

test("canonical decoding captures getter values once before validating and returning", () => {
  let reads = 0
  const value = { ...snapshot }
  Object.defineProperty(value, "project", {
    get: () => (++reads === 1 ? "/repo/a" : "relative"),
  })
  const decoded = canonical.decodeCanonicalBacklogSnapshot(value)
  assert.ok(decoded)
  assert.equal(decoded.project, "/repo/a")
  assert.equal(reads, 1)
})

test("canonical reflection failures reject data instead of escaping", () => {
  const invalid = new Proxy(snapshot, {
    get: () => {
      throw new Error("private detail")
    },
  })
  const revoked = Proxy.revocable(snapshot, {})
  revoked.revoke()
  const items = [...snapshot.items]
  Object.defineProperty(items, 0, {
    get: () => {
      throw new Error("bad slot")
    },
  })
  for (const value of [invalid, revoked.proxy, { ...snapshot, items }]) {
    assert.doesNotThrow(() => {
      assert.equal(canonical.decodeCanonicalBacklogSnapshot(value), undefined)
    })
  }
})

test("canonical snapshot fields remain stable after caller-owned records change", () => {
  const item = { ...snapshot.items[0], requirements: ["Original work"] }
  const input = { ...snapshot, items: [item] }
  const decoded = canonical.decodeCanonicalBacklogSnapshot(input)
  assert.ok(decoded)
  item.requirements[0] = "Replaced work"
  item.status = "ready"
  input.items.length = 0
  assert.equal(decoded.items.length, 1)
  assert.equal(decoded.items[0]?.status, "blocked")
  assert.deepEqual(decoded.items[0]?.requirements, ["Original work"])
})

test("inherited canonical fields and unrelated input properties remain accepted", () => {
  const inherited: unknown = Object.create(snapshot)
  assert.deepEqual(
    canonical.decodeCanonicalBacklogSnapshot(inherited),
    snapshot,
  )
  const extended = { ...snapshot }
  Object.defineProperty(extended, "unmodeled", {
    get: () => {
      throw new Error("unused field")
    },
  })
  assert.deepEqual(canonical.decodeCanonicalBacklogSnapshot(extended), snapshot)
})

test("portable source imports stay inside the declared dependency boundary", () => {
  const allowed = new Set([
    "node:path",
    "node:crypto",
    "effect",
    "./canonical-backlog.ts",
  ])
  for (const name of ["canonical-backlog.ts", "backlog-normalization.ts"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8")
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(/u)
    for (const match of source.matchAll(
      /\b(?:from|import)\s*["']([^"']+)["']/gu,
    )) {
      assert.ok(
        match[1] && allowed.has(match[1]),
        `${name}: unexpected static dependency`,
      )
    }
    assert.doesNotMatch(
      source,
      /CANONICAL_BACKLOG_EVENT|CanonicalBacklogEventEmitter|emitter\.emit|process\.env|Date\.now\(/u,
    )
  }
})

test("portable modules preserve the agreed runtime export names", () => {
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
