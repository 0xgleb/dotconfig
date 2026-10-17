import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { registryListingResult, type RegistryListQuery } from "./listing.ts"
import type { RegistryRequest, RegistrySnapshot } from "./registry.ts"

const request = (
  index: number,
  role = "pi-support",
  project = "/project",
): RegistryRequest => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  project,
  role,
  requesterId: "sender",
  priority: "normal",
  status: "queued",
  text: `request ${index} ${"body".repeat(2000)}`,
  createdAt: index,
  updatedAt: index,
})
const snapshot: RegistrySnapshot = {
  version: 1,
  leases: [],
  requests: [
    ...Array.from({ length: 455 }, (_, index) => request(index)),
    request(456, "receiver"),
    request(457, "storyteller"),
    request(458, "pi-support", "/other"),
  ],
}
const list = (query: RegistryListQuery, value = snapshot) =>
  Effect.runSync(registryListingResult(value, query, "me", 1000))
const text = (query: RegistryListQuery, value = snapshot) =>
  list(query, value).content[0].text

test("the actual tool branch forwards all listing filters and exact lookup", async () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = source.indexOf(
    'if (request.action === "list" || request.action === "requests")',
  )
  const end = source.indexOf('if (request.action === "claim")', start)
  assert.ok(start >= 0 && end > start)
  const branch = source.slice(start, end)
  const execute = new Function(
    "request",
    "store",
    "run",
    "registryListingResult",
    "agent",
    "now",
    `return (async () => { ${branch} })()`,
  )
  const cancelled = Array.from({ length: 5 }, (_, index) => ({
    ...request(1000 + index),
    status: "cancelled" as const,
  }))
  const value = { ...snapshot, requests: [...snapshot.requests, ...cancelled] }
  const invoke = (query: RegistryListQuery) =>
    execute(
      query,
      { snapshot: () => Effect.succeed(value) },
      Effect.runPromise,
      registryListingResult,
      { id: "me" },
      1000,
    ) as Promise<
      Effect.Effect.Success<ReturnType<typeof registryListingResult>>
    >
  for (const action of ["list", "requests"] as const) {
    const result = await invoke({
      action,
      project: "/project",
      role: "pi-support",
      requestStatus: "cancelled",
      limit: 2,
      offset: 2,
    })
    assert.match(result.content[0].text, /offset 2.*requests: 2 of 5/)
    assert.match(result.content[0].text, new RegExp(cancelled[2]!.id))
    assert.doesNotMatch(result.content[0].text, new RegExp(cancelled[0]!.id))
    assert.equal(result.details.action, action)
    assert.equal("snapshot" in result.details, false)
  }
  const detail = await invoke({
    action: "requests",
    requestId: cancelled[0]!.id,
  })
  assert.equal(detail.details.kind, "registry-request-detail")
  assert.ok(detail.content[0].text.endsWith(cancelled[0]!.text))
})

test("requests pages do not inspect the unrelated roster", () => {
  const value: RegistrySnapshot = {
    version: 1,
    requests: snapshot.requests,
    get agents() {
      assert.fail("requests lane inspected agents")
    },
    get leases() {
      assert.fail("requests lane inspected leases")
    },
  }
  assert.match(
    text(
      { action: "requests", project: "/project", role: "pi-support", limit: 1 },
      value,
    ),
    /requests: 1 of 455/,
  )
})

test("filters project and role before paging and omits bodies from details", () => {
  const result = list({
    action: "requests",
    project: "/project",
    role: "pi-support",
  })
  assert.match(result.content[0].text, /requests: 20 of 455/)
  assert.match(result.content[0].text, /offset=20/)
  assert.doesNotMatch(result.content[0].text, /receiver|storyteller|\/other/)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32_000)
  assert.doesNotMatch(
    JSON.stringify(result.details),
    /body|snapshot|requesterId/,
  )
  assert.match(
    result.content[0].text,
    /not total external backlog or source coverage/,
  )
})

test("stable pages cover every matching ID exactly once on an unchanged snapshot", () => {
  const ids = new Set<string>()
  for (let offset = 0; offset < 455; offset += 20) {
    const result = list({
      action: "requests",
      project: "/project",
      role: "pi-support",
      offset,
    })
    for (const match of result.content[0].text.matchAll(/\? (\S+)/g))
      ids.add(match[1]!)
    assert.equal(result.details.kind, "registry-list-page")
  }
  assert.equal(ids.size, 455)
  const last = list({
    action: "requests",
    project: "/project",
    role: "pi-support",
    offset: 440,
  })
  assert.equal("nextOffset" in last.details, false)
  assert.match(last.content[0].text, /15 of 455/)
})

test("status filters expose terminal rows rather than silently hiding them", () => {
  const cancelled = { ...request(1), status: "cancelled" as const }
  const value = {
    version: 1 as const,
    leases: [],
    requests: [request(2), cancelled],
  }
  assert.match(
    text({ action: "requests", requestStatus: "cancelled" }, value),
    /\? .*cancelled/,
  )
  assert.doesNotMatch(text({ action: "requests" }, value), /\? .*cancelled/)
  assert.equal(
    text({ action: "requests", requestStatus: "all" }, value)
      .split("\n")
      .filter(line => line.startsWith("? ")).length,
    2,
  )
})

test("exact lookup returns one full body without the fleet snapshot and honors filters", () => {
  const target = snapshot.requests[23]!
  const result = list({ action: "requests", requestId: target.id })
  assert.ok(result.content[0].text.endsWith(target.text))
  assert.deepEqual(result.details, {
    outcome: "success",
    action: "requests",
    kind: "registry-request-detail",
    requestId: target.id,
  })
  for (const query of [
    { action: "requests", requestId: "00000000" },
    { action: "requests", requestId: target.id, role: "receiver" },
    { action: "requests", requestId: target.id, project: "/other" },
    { action: "requests", requestId: target.id, offset: 0 },
  ] satisfies RegistryListQuery[]) {
    assert.equal(
      Effect.runSync(
        Effect.either(registryListingResult(snapshot, query, "me", 1000)),
      )._tag,
      "Left",
    )
  }
})

test("malformed pagination and filters fail rather than coerce or widen scope", () => {
  for (const query of [
    { limit: 0 },
    { limit: 21 },
    { limit: NaN },
    { limit: 1.5 },
    { limit: null },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Infinity },
    { offset: 9999 },
    { requestStatus: "bogus" },
    { role: " " },
    { project: null },
    { requestId: "" },
  ]) {
    const result = Effect.runSync(
      Effect.either(
        registryListingResult(
          snapshot,
          { action: "requests", ...query } as RegistryListQuery,
          "me",
          1000,
        ),
      ),
    )
    assert.equal(result._tag, "Left", JSON.stringify(query))
  }
})

test("role filtering bounds the roster too and does not mutate its source", () => {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const identity = {
      id: `agent-${String(index).padStart(3, "0")}`,
      pid: index + 1,
    }
    return {
      agent: {
        identity,
        cwd: "/project",
        label: `label-${index}`,
        heartbeatAt: 1,
        expiresAt: 10000,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
      },
      lease: {
        id: `lease-${index}`,
        project: "/project",
        role: index < 45 ? "pi-support" : "receiver",
        owner: identity,
        mode: "operational" as const,
        status: "active" as const,
        policyDigest: "p",
        acquiredAt: 1,
        heartbeatAt: 1,
        expiresAt: 10000,
      },
    }
  })
  const value = {
    ...snapshot,
    agents: rows.map(row => row.agent),
    leases: rows.map(row => row.lease),
  }
  const before = JSON.stringify(value)
  const result = list(
    { action: "list", project: "/project", role: "pi-support", limit: 10 },
    value,
  )
  assert.match(
    result.content[0].text,
    /agents: 10 of 45; roles: 10 of 45; requests: 10 of 455/,
  )
  assert.doesNotMatch(result.content[0].text, /receiver/)
  const requestsOnly = list(
    { action: "requests", project: "/project", role: "pi-support" },
    value,
  )
  assert.doesNotMatch(requestsOnly.content[0].text, /Live agents:|label-/)
  assert.equal(JSON.stringify(value), before)
})

test("urgent requests precede normal requests, oldest first with stable ID ties", () => {
  const rows = [
    request(8),
    { ...request(4), priority: "urgent" as const },
    { ...request(2), priority: "urgent" as const },
  ]
  const output = text(
    { action: "requests", limit: 1 },
    { version: 1, leases: [], requests: rows },
  )
  assert.match(output, new RegExp(`\\? ${rows[2]!.id}`))
  assert.doesNotMatch(output, new RegExp(`\\? ${rows[1]!.id}`))
})

test("embedded newlines cannot forge extra rows or bypass the response bound", () => {
  const value = {
    ...snapshot,
    requests: snapshot.requests.map(row => ({
      ...row,
      requesterLabel: "line\n".repeat(8000),
    })),
  }
  const result = list({ action: "list" }, value)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32_000)
  assert.ok(result.content[0].text.split("\n").length < 80)
})

test("untrusted Unicode rows cannot exceed the response bound", () => {
  const value = {
    ...snapshot,
    requests: snapshot.requests.map(row => ({
      ...row,
      requesterLabel: "😀".repeat(8000),
      project: "/" + "😀".repeat(1000),
    })),
  }
  const result = list({ action: "list" }, value)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32_000)
  assert.match(result.content[0].text, /\.\.\./)
})
