import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"

import { backlogSnapshotFromToolRequest } from "./backlog-ingest-tool.ts"

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect)

test("backlog ingest tool adapts a bounded GitHub tracker snapshot", async () => {
  const snapshot = await run(
    backlogSnapshotFromToolRequest(
      {
        action: "ingest_backlog",
        sourceKind: "github",
        repository: "example/repo",
        coverage: "complete",
        trackerItems: [
          {
            kind: "issue",
            number: 4,
            title: "Keep the owner requirement",
            state: "open",
            labels: [],
            updatedAt: "2026-09-01T00:00:00Z",
          },
        ],
      },
      "/Users/example/repo",
      10_000,
    ),
  )

  assert.equal(snapshot.project, "/Users/example/repo")
  assert.equal(snapshot.source, "tracker-item")
  assert.equal(snapshot.coverage, "complete")
  assert.deepEqual(snapshot.items[0]?.requirements, [
    "Keep the owner requirement",
  ])
})

test("backlog ingest tool adapts explicit document declarations", async () => {
  const snapshot = await run(
    backlogSnapshotFromToolRequest(
      {
        action: "ingest_backlog",
        sourceKind: "document",
        documentId: "BACKLOG.md",
        content: [
          "<!-- pi-backlog:complete -->",
          "```pi-backlog",
          JSON.stringify({
            id: "one",
            status: "ready",
            priority: "normal",
            requirements: ["One exact requirement"],
          }),
          "```",
        ].join("\n"),
      },
      "/Users/example/repo",
      10_001,
    ),
  )

  assert.equal(snapshot.source, "backlog-document")
  assert.equal(snapshot.coverage, "complete")
  assert.deepEqual(snapshot.items[0]?.requirements, ["One exact requirement"])
})

test("backlog ingest tool rejects cross-project and ambiguous source inputs", async () => {
  await assert.rejects(
    run(
      backlogSnapshotFromToolRequest(
        {
          action: "ingest_backlog",
          project: "/Users/example/other",
          sourceKind: "document",
          documentId: "BACKLOG.md",
          content: "# backlog",
        },
        "/Users/example/repo",
        10_002,
      ),
    ),
    /current project/,
  )

  await assert.rejects(
    run(
      backlogSnapshotFromToolRequest(
        {
          action: "ingest_backlog",
          sourceKind: "github",
          repository: "example/repo",
          coverage: "partial",
          trackerItems: [],
          documentId: "BACKLOG.md",
          content: "# must not be silently ignored",
        },
        "/Users/example/repo",
        10_003,
      ),
    ),
    /GitHub source fields/,
  )
})
