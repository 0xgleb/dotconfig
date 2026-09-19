import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const modules = [
  "agent-registry/backlog",
  "agent-registry/registry",
  "agent-registry/runtime-identity",
  "agent-registry/usage",
  "agent-registry/sqlite-store",
  "shared/backlog-events",
  "shared/canonical-backlog",
] as const

const consumer = `
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Effect, Either } from "effect";
import { makeSqliteRegistryStore } from "./agent-registry/sqlite-store.js";
import { RegistryError } from "./agent-registry/registry.js";
import { decodeCanonicalBacklogSnapshot } from "./shared/canonical-backlog.js";

assert.throws(() => import.meta.resolve("@earendil-works/pi-agent-core"), {code: "ERR_MODULE_NOT_FOUND"});
assert.throws(() => import.meta.resolve("@earendil-works/pi-coding-agent"), {code: "ERR_MODULE_NOT_FOUND"});
const root = fileURLToPath(new URL("./database/", import.meta.url));
const input = {
  project: "/fixture/project", source: "tracker-item", scopeId: "github:fixture/repository",
  coverage: "complete", observedAt: 1000,
  items: [{canonicalId: "issue-1", sourceId: "github:fixture/repository:issue-1:revision-1",
    requirements: ["Synthetic migration requirement"], status: "ready", priority: "urgent"}],
};
const snapshot = decodeCanonicalBacklogSnapshot(input);
assert.ok(snapshot);
assert.equal(decodeCanonicalBacklogSnapshot({...input, coverage: "unknown"}), undefined);
const first = makeSqliteRegistryStore(root);
let expected;
try {
  const reconciled = await Effect.runPromise(first.reconcileCanonicalBacklog(snapshot));
  assert.equal(reconciled.items.length, 1);
  assert.equal(reconciled.items[0].state.kind, "ready");
  assert.equal(reconciled.items[0].priority, "urgent");
  assert.equal(reconciled.sources.length, 1);
  assert.equal(reconciled.sources[0].authority.kind, "routing-only");
  assert.equal(reconciled.requirements[0].text, "Synthetic migration requirement");
  const repeated = await Effect.runPromise(first.reconcileCanonicalBacklog(snapshot));
  assert.equal(repeated.items.length, 1);
  assert.equal(repeated.items[0].id, reconciled.items[0].id);
  expected = await Effect.runPromise(first.backlogSnapshot(input.project));
  // Reconciliation starts ingestion before it rejects the missing blocked reason.
  // The transaction must preserve every prior row when that later step fails.
  const invalid = {...snapshot, observedAt: 1001, items: [{...snapshot.items[0],
    sourceId: "github:fixture/repository:issue-1:revision-2", status: "blocked"}]};
  assert.equal(decodeCanonicalBacklogSnapshot(invalid), undefined);
  const rejected = await Effect.runPromise(Effect.either(first.reconcileCanonicalBacklog(invalid)));
  assert.ok(Either.isLeft(rejected));
  assert.ok(rejected.left instanceof RegistryError);
  assert.equal(rejected.left.code, "invalid_input");
  assert.deepEqual(await Effect.runPromise(first.backlogSnapshot(input.project)), expected);
} finally {
  first.close();
}
const reopened = makeSqliteRegistryStore(root);
try {
  assert.deepEqual(await Effect.runPromise(reopened.backlogSnapshot(input.project)), expected);
} finally {
  reopened.close();
}
console.log("portable canonical backlog verified");
`

test("compiled canonical backlog preserves provenance, reconciliation, rollback and restart without Pi", async () => {
  const sourceRoot = new URL("../", import.meta.url)
  const fixtureRoot = fileURLToPath(
    new URL("../../../../.tmp/metagenda-migration/", import.meta.url),
  )
  await mkdir(fixtureRoot, { recursive: true })
  const fixture = await mkdtemp(join(fixtureRoot, "work-core-consumer-"))
  const effectLink = join(fixture, "node_modules", "effect")
  let linked = false
  try {
    await mkdir(join(fixture, "node_modules"))
    await symlink(
      fileURLToPath(new URL("node_modules/effect", sourceRoot)),
      effectLink,
      "dir",
    )
    linked = true
    await writeFile(
      join(fixture, "package.json"),
      '{"type":"module","private":true}\n',
    )
    for (const name of modules) {
      const source = readFileSync(new URL(`${name}.ts`, sourceRoot), "utf8")
      const compiled = stripTypeScriptTypes(source).replace(
        /(\.{1,2}\/[^"\n]+)\.ts"/gu,
        '$1.js"',
      )
      const target = join(fixture, `${name}.js`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, compiled)
    }
    await writeFile(join(fixture, "consumer.mjs"), consumer)
    const result = spawnSync(
      process.execPath,
      [join(fixture, "consumer.mjs")],
      {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10000,
      },
    )
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /portable canonical backlog verified/u)
  } finally {
    try {
      if (linked) await unlink(effectLink)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})
