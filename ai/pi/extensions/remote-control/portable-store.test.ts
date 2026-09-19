import assert from "node:assert/strict"
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
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import * as bridgeContract from "./bridge-contract.ts"
import * as legacyProtocol from "./protocol.ts"

const consumer = `
import assert from "node:assert/strict";
import { Effect, Either } from "effect";
import { makeRemoteBridgeStore } from "./sqlite-store.js";
import { fileURLToPath } from "node:url";

await assert.rejects(import("@earendil-works/pi-agent-core"), {code: "ERR_MODULE_NOT_FOUND"});
await assert.rejects(import("@earendil-works/pi-ai"), {code: "ERR_MODULE_NOT_FOUND"});
const database = fileURLToPath(new URL("./fixture.sqlite", import.meta.url));
const agent = {
  id: "fixture-agent", label: "Fixture", cwd: "/fixture/project",
  accepting: true, workDelivery: "native-pi", now: 1000, ttlMs: 15000,
};
const input = {
  targetAgentId: agent.id, requesterId: "fixture-sender",
  dedupeKey: "fixture-message", text: "Synthetic migration fixture",
  now: 1001, ttlMs: 60000,
};
let store = makeRemoteBridgeStore(database);
{
  await Effect.runPromise(store.setEnabled(true));
  await Effect.runPromise(store.heartbeatAgent(agent));
  const queued = await Effect.runPromise(store.enqueue(input));
  const duplicate = await Effect.runPromise(store.enqueue(input));
  assert.equal(duplicate.id, queued.id);
  store = makeRemoteBridgeStore(database);
  const claimed = await Effect.runPromise(store.claimNext({agentId: agent.id, now: 1002}));
  assert.ok(claimed);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.id, queued.id);
  const wrongToken = await Effect.runPromise(Effect.either(store.complete({
    messageId: claimed.id, claimToken: "wrong-token", response: "No", now: 1003,
  })));
  assert.ok(Either.isLeft(wrongToken));
  assert.equal(wrongToken.left.code, "invalid_transition");
  await Effect.runPromise(store.complete({
    messageId: claimed.id, claimToken: claimed.claimToken, response: "Done", now: 1004,
  }));
  store = makeRemoteBridgeStore(database);
  const completed = await Effect.runPromise(store.get(claimed.id, 1005));
  assert.equal(completed.status, "completed");
  assert.equal(completed.response, "Done");
  const malformed = await Effect.runPromise(Effect.either(store.enqueue({...input, now: -1})));
  assert.ok(Either.isLeft(malformed));
  assert.equal(malformed.left.code, "invalid_input");
  await Effect.runPromise(store.setEnabled(false));
  const disabled = await Effect.runPromise(Effect.either(store.enqueue({...input, dedupeKey: "disabled"})));
  assert.ok(Either.isLeft(disabled));
  assert.equal(disabled.left.code, "disabled");
}
console.log("portable bridge persistence verified");
`

test("legacy protocol preserves every portable runtime export's identity", () => {
  for (const [name, value] of Object.entries(bridgeContract)) {
    assert.equal(Reflect.get(legacyProtocol, name), value, name)
  }
})

test("compiled bridge storage works without Pi host, chat, or personal modules", async () => {
  const sourceRoot = new URL("./", import.meta.url)
  const fixtureRoot = fileURLToPath(
    new URL(
      "../../../../.tmp/metagenda-migration/bridge-tests/",
      import.meta.url,
    ),
  )
  await mkdir(fixtureRoot, { recursive: true })
  const fixture = await mkdtemp(join(fixtureRoot, "consumer-"))
  const effectLink = join(fixture, "node_modules", "effect")
  let linked = false
  try {
    await mkdir(join(fixture, "node_modules"))
    await symlink(
      fileURLToPath(new URL("../node_modules/effect", sourceRoot)),
      effectLink,
      "dir",
    )
    linked = true
    await writeFile(
      join(fixture, "package.json"),
      '{"type":"module","private":true}\n',
    )
    for (const name of ["sqlite-store", "bridge-contract"]) {
      const source = readFileSync(new URL(`${name}.ts`, sourceRoot), "utf8")
      const compiled = stripTypeScriptTypes(source).replace(
        /(\.\/[^"\n]+)\.ts"/gu,
        '$1.js"',
      )
      await writeFile(join(fixture, `${name}.js`), compiled)
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
    assert.match(result.stdout, /portable bridge persistence verified/u)
  } finally {
    if (linked) await unlink(effectLink)
    await rm(fixture, { recursive: true, force: true })
  }
})
