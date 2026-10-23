import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { registryListingResult, type RegistryListQuery } from "./listing.ts"
import type { RegisteredAgent, RegistrySnapshot } from "./registry.ts"
import { makeSqliteRegistryStore } from "./sqlite-store.ts"

const firstSession = "00000000-0000-4000-8000-000000000001"
const secondSession = "00000000-0000-4000-8000-000000000002"
const agent = (session: string, cwd = "/projects/worker"): RegisteredAgent => ({
  identity: { id: `${session}:pid:123`, pid: 123 },
  cwd,
  label: "existing worker",
  heartbeatAt: 1,
  expiresAt: 10000,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
})
const snapshot = (agents: readonly RegisteredAgent[]): RegistrySnapshot => ({
  version: 1,
  agents: [...agents],
  leases: [],
  requests: [],
})
const invoke = (value: RegistrySnapshot, query: RegistryListQuery) =>
  Effect.runSync(
    registryListingResult(value, query, `${firstSession}:pid:123`, 1000),
  )
const selectionsFromModelText = (
  result: ReturnType<typeof invoke>,
): unknown => {
  const block = Array.from(result.content).find(item =>
    item.text.startsWith('{"workerSelections":'),
  )
  if (block === undefined)
    return assert.fail(
      "exact selection data must be model-visible JSON, not only hidden details",
    )
  const data: unknown = JSON.parse(block.text)
  if (
    typeof data !== "object" ||
    data === null ||
    !("workerSelections" in data)
  )
    return assert.fail(
      "model-visible selection must have its explicit record list",
    )
  return data.workerSelections
}

test("opt-in selection preserves full runtime/session identities including self and shared display prefixes", () => {
  const rows = [agent(firstSession), agent(secondSession)]
  const result = invoke(snapshot(rows), {
    action: "list",
    includeSelection: true,
  })
  assert.match(result.content[0].text, /session you/)
  const expected = rows.map(row => ({
    kind: "runtime-session",
    agentId: row.identity.id,
    workerSessionId: row.identity.id.split(":pid:")[0],
    cwd: row.cwd,
  }))
  assert.deepEqual(selectionsFromModelText(result), expected)
  if (!("workerSelections" in result.details))
    return assert.fail(
      "typed details must mirror the exact model-visible records",
    )
  assert.deepEqual(result.details.workerSelections, expected)
})

test("default and explicit false preserve the existing preview-only response", () => {
  const value = snapshot([agent(firstSession)])
  const normal = invoke(value, { action: "list" })
  assert.deepEqual(
    invoke(value, { action: "list", includeSelection: false }),
    normal,
  )
  assert.equal(normal.content.length, 1)
  assert.equal("workerSelections" in normal.details, false)
})

test("exact selection is derived only from the filtered page without changing stored values", () => {
  const rows = [
    agent(firstSession),
    agent(secondSession),
    agent("other", "/other"),
  ]
  const value = snapshot(rows)
  const before = JSON.stringify(value)
  const result = invoke(value, {
    action: "list",
    project: "/projects/worker",
    limit: 1,
    offset: 1,
    includeSelection: true,
  })
  assert.deepEqual(selectionsFromModelText(result), [
    {
      kind: "runtime-session",
      agentId: rows[1]!.identity.id,
      workerSessionId: secondSession,
      cwd: "/projects/worker",
    },
  ])
  assert.equal(JSON.stringify(value), before)
})

test("unparseable legacy identities are explicit, never guessed sessions", () => {
  const legacy = {
    ...agent(firstSession),
    identity: { id: "legacy-id", pid: 123 },
  }
  const result = invoke(snapshot([legacy]), {
    action: "list",
    includeSelection: true,
  })
  assert.deepEqual(selectionsFromModelText(result), [
    { kind: "unsupported-identity", agentId: "legacy-id" },
  ])
})

test("Unicode, quotes and internal whitespace round-trip outside the bounded summary rows", () => {
  const cwd = "/" + "😀".repeat(490) + '/"line\ninside\\end'
  assert.ok(cwd.length <= 1024)
  const result = invoke(snapshot([agent(firstSession, cwd)]), {
    action: "list",
    includeSelection: true,
  })
  assert.deepEqual(selectionsFromModelText(result), [
    {
      kind: "runtime-session",
      agentId: `${firstSession}:pid:123`,
      workerSessionId: firstSession,
      cwd,
    },
  ])
  for (const line of result.content[0].text.split("\n"))
    assert.ok(Buffer.byteLength(line) <= 512)
})

test("an oversized exact page fails explicitly and can be retried at limit one without truncating a selector", () => {
  const cwd = "/a" + "\n".repeat(1000) + "z"
  const value = snapshot(
    Array.from({ length: 20 }, (_, index) => agent(`worker-${index}`, cwd)),
  )
  const failed = Effect.runSync(
    Effect.either(
      registryListingResult(
        value,
        { action: "list", includeSelection: true },
        "me",
        1000,
      ),
    ),
  )
  assert.equal(failed._tag, "Left")
  if (failed._tag === "Left") {
    assert.equal(failed.left.code, "invalid_input")
    assert.match(failed.left.message, /limit/)
  }
  const retry = invoke(value, {
    action: "list",
    limit: 1,
    includeSelection: true,
  })
  assert.ok(
    Array.from(retry.content).reduce<number>(
      (sum, item) => sum + Buffer.byteLength(item.text),
      0,
    ) <= 32000,
  )
  assert.ok(JSON.stringify(selectionsFromModelText(retry)).includes("\\n"))
})

test("selection is rejected on request-only/detail calls before inspecting any roster", () => {
  const value: RegistrySnapshot = {
    version: 1,
    requests: [],
    get agents() {
      return assert.fail("requests must not inspect agents")
    },
    get leases() {
      return assert.fail("requests must not inspect leases")
    },
  }
  for (const query of [
    { action: "requests", includeSelection: true },
    { action: "requests", includeSelection: true, requestId: "r" },
  ] satisfies RegistryListQuery[]) {
    const result = Effect.runSync(
      Effect.either(registryListingResult(value, query, "me", 1000)),
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") assert.equal(result.left.code, "invalid_input")
  }
})

test("maximum accepted registration values survive SQLite and model-visible selection unchanged", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "registry-selection-"))
  const store = makeSqliteRegistryStore(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true })
  })
  const session = "s".repeat(120)
  const cwd = "/" + "😀".repeat(510) + "aaa"
  const input = agent(session, cwd)
  assert.equal(input.identity.id.length, 128)
  assert.equal(cwd.length, 1024)
  const registered = await Effect.runPromise(
    store.heartbeatAgent({
      agent: input.identity,
      cwd,
      label: "😀".repeat(80),
      usage: input.usage,
      now: 1000,
      ttlMs: 60000,
    }),
  )
  const value = await Effect.runPromise(store.snapshot(1001))
  const result = invoke(value, { action: "list", includeSelection: true })
  assert.deepEqual(selectionsFromModelText(result), [
    {
      kind: "runtime-session",
      agentId: registered.identity.id,
      workerSessionId: session,
      cwd: registered.cwd,
    },
  ])
  assert.equal(registered.cwd, cwd)
})

test("malformed includeSelection cannot silently fall back to a preview", () => {
  const query = {
    action: "list",
    includeSelection: "true",
  } as unknown as RegistryListQuery
  const result = Effect.runSync(
    Effect.either(registryListingResult(snapshot([]), query, "me", 1000)),
  )
  assert.equal(result._tag, "Left")
})
