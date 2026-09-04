import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"

import {
  backlogDocumentSnapshot,
  emitBacklogDocumentSnapshot,
  emitGitHubTrackerSnapshot,
  githubTrackerSnapshot,
} from "./backlog-source-adapters.ts"
import { CANONICAL_BACKLOG_EVENT } from "./backlog-events.ts"

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

test("source adapters emit only validated canonical snapshots", async () => {
  const events: { readonly name: string; readonly value: unknown }[] = []
  const emitter = {
    emit: (name: string, value: unknown) => {
      events.push({ name, value })
    },
  }
  await run(
    emitGitHubTrackerSnapshot(emitter, {
      project: "/Users/example/repo",
      repository: "example/repo",
      observedAt: 5_000,
      coverage: "complete",
      items: [],
    }),
  )
  await run(
    emitBacklogDocumentSnapshot(emitter, {
      project: "/Users/example/repo",
      documentId: "BACKLOG.md",
      observedAt: 5_001,
      content: "<!-- pi-backlog:complete -->",
    }),
  )

  assert.deepEqual(
    events.map(event => event.name),
    [CANONICAL_BACKLOG_EVENT, CANONICAL_BACKLOG_EVENT],
  )
  assert.deepEqual(
    events.map(event =>
      typeof event.value === "object" && event.value !== null
        ? (event.value as { readonly source?: unknown }).source
        : undefined,
    ),
    ["tracker-item", "backlog-document"],
  )
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
