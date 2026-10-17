import assert from "node:assert/strict"
import test from "node:test"
import { Worker } from "node:worker_threads"
import { Effect, Either } from "effect"

import {
  BacklogSourceAdapterError,
  backlogDocumentSnapshot,
  githubTrackerSnapshot,
  type GitHubTrackerItemInput,
} from "./backlog-normalization.ts"

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect)

test("GitHub tracker adapter preserves requirements and maps lifecycle", async () => {
  const project = "/Users/example/repo"
  const snapshot = await run(
    githubTrackerSnapshot({
      project,
      repository: "example/repo",
      observedAt: 1_000,
      coverage: "complete",
      items: [
        {
          kind: "issue",
          number: 7,
          title: "Restore durable replay",
          body: "Keep the cursor monotonic.\nReject malformed provider state.",
          state: "open",
          labels: ["priority:urgent", "blocked"],
          updatedAt: "2026-09-01T00:00:00Z",
        },
        {
          kind: "pull-request",
          number: 9,
          title: "Ship the replay repair",
          body: "Preserve every acceptance criterion.",
          state: "merged",
          labels: [],
          updatedAt: "2026-09-01T01:00:00Z",
        },
        {
          kind: "pull-request",
          number: 10,
          title: "Retired approach",
          state: "closed",
          labels: [],
          updatedAt: "2026-09-01T02:00:00Z",
        },
      ],
    }),
  )

  assert.equal(snapshot.project, project)
  assert.equal(snapshot.source, "tracker-item")
  assert.equal(snapshot.scopeId, "github:example/repo")
  assert.equal(snapshot.coverage, "complete")
  assert.deepEqual(
    snapshot.items.map(item => ({
      canonicalId: item.canonicalId,
      status: item.status,
      priority: item.priority,
      reason: item.reason,
      requirements: item.requirements,
    })),
    [
      {
        canonicalId: "issue:7",
        status: "blocked",
        priority: "urgent",
        reason: "GitHub label: blocked",
        requirements: [
          "Restore durable replay",
          "Keep the cursor monotonic.\nReject malformed provider state.",
        ],
      },
      {
        canonicalId: "pull-request:9",
        status: "completed",
        priority: "normal",
        reason: undefined,
        requirements: [
          "Ship the replay repair",
          "Preserve every acceptance criterion.",
        ],
      },
      {
        canonicalId: "pull-request:10",
        status: "cancelled",
        priority: "normal",
        reason: undefined,
        requirements: ["Retired approach"],
      },
    ],
  )
  assert.equal(
    new Set(snapshot.items.map(item => item.sourceId)).size,
    snapshot.items.length,
  )
})

test("GitHub tracker revisions retain one canonical identity with immutable source identities", async () => {
  const base = {
    project: "/Users/example/repo",
    repository: "example/repo",
    observedAt: 1_000,
    coverage: "partial" as const,
  }
  const first = await run(
    githubTrackerSnapshot({
      ...base,
      items: [
        {
          kind: "issue",
          number: 7,
          title: "First requirement",
          state: "open",
          labels: [],
          updatedAt: "2026-09-01T00:00:00Z",
        },
      ],
    }),
  )
  const second = await run(
    githubTrackerSnapshot({
      ...base,
      observedAt: 2_000,
      items: [
        {
          kind: "issue",
          number: 7,
          title: "First requirement",
          body: "Second requirement",
          state: "open",
          labels: [],
          updatedAt: "2026-09-01T01:00:00Z",
        },
      ],
    }),
  )

  assert.equal(first.items[0]?.canonicalId, second.items[0]?.canonicalId)
  assert.notEqual(first.items[0]?.sourceId, second.items[0]?.sourceId)
  assert.deepEqual(second.items[0]?.requirements, [
    "First requirement",
    "Second requirement",
  ])
})

test("backlog document adapter reads only explicit bounded declarations", async () => {
  const snapshot = await run(
    backlogDocumentSnapshot({
      project: "/Users/example/repo",
      documentId: "ROADMAP.md",
      observedAt: 3_000,
      content: [
        "# Roadmap",
        "",
        "Ordinary prose is not interpreted as work.",
        "",
        "<!-- pi-backlog:complete -->",
        "```pi-backlog",
        JSON.stringify([
          {
            id: "durable-replay",
            status: "ready",
            priority: "urgent",
            requirements: ["Restore replay", "Add malformed-state coverage"],
          },
          {
            id: "provider-docs",
            status: "blocked",
            priority: "normal",
            requirements: ["Pin the provider contract"],
            reason: "Awaiting provider documentation",
          },
          {
            id: "old-plan",
            status: "cancelled",
            priority: "normal",
            requirements: ["Do not revive the retired plan"],
          },
        ]),
        "```",
      ].join("\n"),
    }),
  )

  assert.equal(snapshot.source, "backlog-document")
  assert.equal(snapshot.scopeId, "document:ROADMAP.md")
  assert.equal(snapshot.coverage, "complete")
  assert.deepEqual(
    snapshot.items.map(item => ({
      canonicalId: item.canonicalId,
      status: item.status,
      reason: item.reason,
    })),
    [
      {
        canonicalId: "durable-replay",
        status: "ready",
        reason: undefined,
      },
      {
        canonicalId: "provider-docs",
        status: "blocked",
        reason: "Awaiting provider documentation",
      },
      {
        canonicalId: "old-plan",
        status: "cancelled",
        reason: undefined,
      },
    ],
  )
})

test("Unicode tracker bodies remain within the canonical requirement bounds", async () => {
  const body = "🙂".repeat(2_001)
  const snapshot = await run(
    githubTrackerSnapshot({
      project: "/Users/example/repo",
      repository: "example/repo",
      observedAt: 1_000,
      coverage: "partial",
      items: [
        {
          kind: "issue",
          number: 1,
          title: "Unicode",
          body,
          state: "open",
          labels: [],
          updatedAt: "2026-09-13T00:00:00Z",
        },
      ],
    }),
  )
  const requirements = snapshot.items[0]?.requirements
  assert.ok(requirements)
  assert.equal(requirements[0], "Unicode")
  assert.equal(requirements.slice(1).join(""), body)
  assert.ok(requirements.every(requirement => requirement.length <= 4_000))
})

test("backlog document adapter fails closed on malformed declarations", async () => {
  await assert.rejects(
    run(
      backlogDocumentSnapshot({
        project: "/Users/example/repo",
        documentId: "ROADMAP.md",
        observedAt: 4_000,
        content: [
          "```pi-backlog",
          JSON.stringify({
            id: "unsafe",
            status: "blocked",
            priority: "normal",
            requirements: ["Missing a blocked reason"],
          }),
          "```",
        ].join("\n"),
      }),
    ),
    /blocked declaration requires a reason/,
  )

  await assert.rejects(
    run(
      backlogDocumentSnapshot({
        project: "/Users/example/repo",
        documentId: "ROADMAP.md",
        observedAt: 4_000,
        content: [
          "<!-- pi-backlog:complete -->",
          "```pi-backlog",
          JSON.stringify({
            id: "unfinished",
            status: "ready",
            priority: "normal",
            requirements: ["Fence never closes"],
          }),
        ].join("\n"),
      }),
    ),
    /unterminated backlog fence/,
  )

  await assert.rejects(
    run(
      backlogDocumentSnapshot({
        project: "/Users/example/repo",
        documentId: "../ROADMAP.md",
        observedAt: 4_000,
        content: "# no declarations",
      }),
    ),
    /documentId/,
  )
})

test("fence scan preflight preserves prefix, suffix, CRLF and overlapping-marker behavior", async () => {
  const declaration = {
    id: "one",
    status: "ready",
    priority: "normal",
    requirements: ["work"],
  }
  const fence = "```pi-backlog\n" + JSON.stringify(declaration) + "\n```"
  const input = { project: "/repo", documentId: "ROADMAP.md", observedAt: 1 }
  const original = await run(
    backlogDocumentSnapshot({ ...input, content: fence }),
  )
  for (const content of [
    "prose " + fence + "suffix",
    fence.replaceAll("\n", "\r\n"),
  ])
    assert.deepEqual(
      await run(backlogDocumentSnapshot({ ...input, content })),
      original,
    )
  for (const content of [
    " ```pi-backlog\n{}\n```pi-backlog\n{}",
    fence + "\nx```pi-backlog\n{}",
    fence + "\nx```pi-backlog",
    "```pi-backlog\n```",
  ]) {
    const result = await Effect.runPromise(
      Effect.either(backlogDocumentSnapshot({ ...input, content })),
    )
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "malformed_declaration")
    assert.equal(
      result.left.message,
      "document contains an unterminated backlog fence",
    )
  }
})

test("maximum-size unterminated fences fail within a bounded worker lifetime", async () => {
  const worker = new Worker(
    [
      "const { parentPort, workerData } = require('node:worker_threads')",
      "Promise.all([import(workerData.normalizer), import(workerData.effect)]).then(async ([{ backlogDocumentSnapshot }, { Effect, Either }]) => {",
      "  const prefix = 'x```pi-backlog\\n'",
      "  const result = await Effect.runPromise(Effect.either(backlogDocumentSnapshot({",
      "    project: '/repo', documentId: 'ROADMAP.md', observedAt: 1,",
      "    content: prefix.repeat(Math.floor((4 * 1024 * 1024) / prefix.length))",
      "  })))",
      "  parentPort.postMessage(Either.isLeft(result) ? { tag: result.left._tag, code: result.left.code } : { unexpectedSuccess: true })",
      "})",
    ].join("\n"),
    {
      eval: true,
      workerData: {
        normalizer: new URL("./backlog-normalization.ts", import.meta.url).href,
        effect: import.meta.resolve("effect"),
      },
    },
  )
  try {
    const result = await new Promise<unknown>(resolve => {
      const finish = (value: unknown) => {
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish({ timedOut: true }), 3_000)
      worker.once("message", finish)
      worker.once("error", (error: Error) =>
        finish({ workerError: error.message }),
      )
      worker.once("exit", code => finish({ unexpectedExit: code }))
    })
    assert.deepEqual(result, {
      tag: "BacklogSourceAdapterError",
      code: "malformed_declaration",
    })
  } finally {
    await worker.terminate()
  }
})

const trackerItem: GitHubTrackerItemInput = {
  kind: "issue",
  number: 1,
  title: "Retain supplied work",
  state: "open",
  labels: [],
  updatedAt: "2026-09-14T00:00:00Z",
}

const trackerInput = (items: readonly GitHubTrackerItemInput[]) => ({
  project: "/repo",
  repository: "org/repo",
  observedAt: 1,
  coverage: "complete" as const,
  items,
})

const expectAdapterError = async <A>(
  effect: Effect.Effect<A, BacklogSourceAdapterError>,
  code: BacklogSourceAdapterError["code"],
) => {
  const result = await Effect.runPromise(Effect.either(effect))
  assert.ok(Either.isLeft(result), "expected a typed adapter failure")
  assert.ok(result.left instanceof BacklogSourceAdapterError)
  assert.equal(result.left.code, code)
}

const forbidSuppliedMethods = (array: unknown[]) => {
  for (const key of ["map", Symbol.iterator])
    Object.defineProperty(array, key, {
      value: () => {
        throw new Error("supplied collection method must not run")
      },
    })
}

test("tracker normalization preserves supplied labels without invoking collection methods", async () => {
  const labels = ["blocked", "p1"]
  const items = [{ ...trackerItem, labels }]
  forbidSuppliedMethods(labels)
  forbidSuppliedMethods(items)
  const snapshot = await run(githubTrackerSnapshot(trackerInput(items)))
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.items[0]?.status, "blocked")
  assert.equal(snapshot.items[0]?.priority, "urgent")
  assert.equal(snapshot.items[0]?.reason, "GitHub label: blocked")
})

test("a supplied map cannot hide duplicate tracker identities", async () => {
  const items = [trackerItem, trackerItem]
  Object.defineProperty(items, "map", { value: () => [] })
  await expectAdapterError(
    githubTrackerSnapshot(trackerInput(items)),
    "invalid_input",
  )
})

test("sparse tracker items and labels fail through the typed error channel", async () => {
  for (const items of [
    new Array<GitHubTrackerItemInput>(1),
    [{ ...trackerItem, labels: new Array<string>(1) }],
  ])
    await expectAdapterError(
      githubTrackerSnapshot(trackerInput(items)),
      "invalid_input",
    )
})

test("tracker body budgeting preserves whitespace filtering and bounded Unicode content", async () => {
  const body = " ".repeat(200_000) + "🙂".repeat(2_001)
  const snapshot = await run(
    githubTrackerSnapshot(trackerInput([{ ...trackerItem, body }])),
  )
  assert.deepEqual(snapshot.items[0]?.requirements, [
    trackerItem.title,
    "🙂".repeat(2_000),
    "🙂",
  ])
  await expectAdapterError(
    githubTrackerSnapshot(
      trackerInput([{ ...trackerItem, body: "x".repeat(128_000) }]),
    ),
    "invalid_input",
  )
})

test("closed issues retain completed and not-planned lifecycle mapping", async () => {
  const snapshot = await run(
    githubTrackerSnapshot(
      trackerInput([
        { ...trackerItem, number: 1, state: "closed" },
        {
          ...trackerItem,
          number: 2,
          state: "closed",
          stateReason: "completed",
        },
        {
          ...trackerItem,
          number: 3,
          state: "closed",
          stateReason: "not-planned",
        },
      ]),
    ),
  )
  assert.deepEqual(
    snapshot.items.map(item => [item.canonicalId, item.status]),
    [
      ["issue:1", "completed"],
      ["issue:2", "completed"],
      ["issue:3", "cancelled"],
    ],
  )
})

test("invalid lifecycle combinations keep their typed input failure", async () => {
  for (const item of [
    { ...trackerItem, state: "merged" as const },
    { ...trackerItem, stateReason: "completed" as const },
    { ...trackerItem, blockedReason: "not blocked" },
  ])
    await expectAdapterError(
      githubTrackerSnapshot(trackerInput([item])),
      "invalid_input",
    )
})

test("throwing input accessors use the typed adapter error channel", async () => {
  const input = trackerInput([trackerItem])
  Object.defineProperty(input, "project", {
    get: () => {
      throw new Error("private input detail")
    },
  })
  await expectAdapterError(githubTrackerSnapshot(input), "invalid_input")
  const item = { ...trackerItem }
  Object.defineProperty(item, "title", {
    get: () => {
      throw new Error("private input detail")
    },
  })
  await expectAdapterError(
    githubTrackerSnapshot(trackerInput([item])),
    "invalid_input",
  )
  const document = {
    project: "/repo",
    documentId: "ROADMAP.md",
    observedAt: 1,
    content: "",
  }
  Object.defineProperty(document, "content", {
    get: () => {
      throw new Error("private input detail")
    },
  })
  await expectAdapterError(backlogDocumentSnapshot(document), "invalid_input")
})

test("throwing array slots and revoked array proxies fail as typed input errors", async () => {
  const items = [trackerItem]
  Object.defineProperty(items, 0, {
    get: () => {
      throw new Error("bad slot")
    },
  })
  await expectAdapterError(
    githubTrackerSnapshot(trackerInput(items)),
    "invalid_input",
  )
  const revoked = Proxy.revocable([trackerItem], {})
  revoked.revoke()
  await expectAdapterError(
    githubTrackerSnapshot(trackerInput(revoked.proxy)),
    "invalid_input",
  )
})

test("document failure codes remain distinct without changing the declaration contract", async () => {
  const input = { project: "/repo", documentId: "ROADMAP.md", observedAt: 1 }
  await expectAdapterError(
    backlogDocumentSnapshot({ ...input, content: "```pi-backlog\n{" }),
    "malformed_declaration",
  )
  await expectAdapterError(
    backlogDocumentSnapshot({
      ...input,
      documentId: "../ROADMAP.md",
      content: "",
    }),
    "invalid_input",
  )
  await expectAdapterError(
    backlogDocumentSnapshot({
      ...input,
      content:
        "```pi-backlog\n" +
        JSON.stringify({
          id: "",
          status: "ready",
          priority: "normal",
          requirements: ["work"],
        }) +
        "\n```",
    }),
    "invalid_input",
  )
})
