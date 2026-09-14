import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Effect, Either } from "effect"
import * as legacyAdapters from "./backlog-source-adapters.ts"
import * as legacyEvents from "./backlog-events.ts"

const input: legacyAdapters.GitHubTrackerSnapshotInput = {
  project: "/repo/a",
  repository: "org/repo",
  observedAt: 1_000,
  coverage: "partial",
  items: [
    {
      kind: "issue",
      number: 7,
      title: "Task",
      body: "Details",
      state: "open",
      labels: [],
      updatedAt: "2026-09-13T00:00:00Z",
    },
  ],
}

test("portable backlog modules expose normalization without host event contracts", async () => {
  await assert.doesNotReject(async () => {
    const pure = await import("./backlog-normalization.ts")
    const canonical = await import("./canonical-backlog.ts")
    assert.deepEqual(Object.keys(pure).sort(), [
      "BacklogSourceAdapterError",
      "backlogDocumentSnapshot",
      "githubTrackerSnapshot",
    ])
    assert.deepEqual(Object.keys(canonical).sort(), [
      "backlogRequirementsFromText",
      "decodeCanonicalBacklogSnapshot",
    ])
    const snapshot = await Effect.runPromise(pure.githubTrackerSnapshot(input))
    assert.equal(snapshot.project, "/repo/a")
    assert.equal(snapshot.scopeId, "github:org/repo")
    assert.equal(snapshot.coverage, "partial")
    assert.equal("version" in snapshot, false)
    assert.equal(snapshot.items[0]?.canonicalId, "issue:7")
    assert.deepEqual(snapshot.items[0]?.requirements, ["Task", "Details"])
    assert.match(
      snapshot.items[0]?.sourceId ?? "",
      /^github:org\/repo:issue:7:[0-9a-f]{20}$/u,
    )
    assert.deepEqual(
      canonical.decodeCanonicalBacklogSnapshot(snapshot),
      snapshot,
    )
    const failed = await Effect.runPromise(
      Effect.either(
        pure.githubTrackerSnapshot({ ...input, project: "relative" }),
      ),
    )
    assert.ok(Either.isLeft(failed))
    assert.ok(failed.left instanceof pure.BacklogSourceAdapterError)
    assert.equal(failed.left.code, "invalid_input")
  })
})

test("existing consumers retain identical functions, error class and event wrappers", async () => {
  const pure = await import("./backlog-normalization.ts")
  const canonical = await import("./canonical-backlog.ts")
  assert.equal(legacyAdapters.githubTrackerSnapshot, pure.githubTrackerSnapshot)
  assert.equal(
    legacyAdapters.backlogDocumentSnapshot,
    pure.backlogDocumentSnapshot,
  )
  assert.equal(
    legacyAdapters.BacklogSourceAdapterError,
    pure.BacklogSourceAdapterError,
  )
  assert.equal(
    legacyEvents.decodeCanonicalBacklogSnapshot,
    canonical.decodeCanonicalBacklogSnapshot,
  )
  assert.equal(
    legacyEvents.backlogRequirementsFromText,
    canonical.backlogRequirementsFromText,
  )
  const emitted: { name: string; value: unknown }[] = []
  const snapshot = await Effect.runPromise(
    legacyAdapters.emitGitHubTrackerSnapshot(
      {
        emit: (name, value) => {
          emitted.push({ name, value })
        },
      },
      input,
    ),
  )
  assert.deepEqual(emitted, [
    { name: legacyEvents.CANONICAL_BACKLOG_EVENT, value: snapshot },
  ])
})

test("portable source dependency closure excludes Pi events and IO adapters", () => {
  for (const name of ["canonical-backlog.ts", "backlog-normalization.ts"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8")
    const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map(
      match => match[1],
    )
    assert.ok(
      imports.every(specifier =>
        [
          "node:crypto",
          "node:path",
          "effect",
          "./canonical-backlog.ts",
        ].includes(specifier ?? ""),
      ),
      `${name} has a host dependency`,
    )
    assert.doesNotMatch(
      source,
      /CANONICAL_BACKLOG_EVENT|CanonicalBacklogEventEmitter|emitter\.emit|process\.env|Date\.now\(/u,
    )
  }
})
