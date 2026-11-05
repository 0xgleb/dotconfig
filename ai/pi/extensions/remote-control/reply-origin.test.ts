import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"

const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "pi-reply-origin-"))
  t.after(() => rmSync(root, { recursive: true }))
  const path = join(root, "bridge.sqlite")
  return { path, store: makeRemoteBridgeStore(path) }
}

test("exact Telegram chat+message origin survives restart without selecting a worker globally", async t => {
  const { store, path } = fixture(t)
  await Effect.runPromise(
    store.linkTelegramMessageOrigin({
      agentId: "worker-a",
      chatId: 10,
      messageId: 20,
    }),
  )
  await Effect.runPromise(
    store.linkTelegramMessageOrigin({
      agentId: "worker-b",
      chatId: 11,
      messageId: 20,
    }),
  )
  const reopened = makeRemoteBridgeStore(path)
  assert.equal(
    await Effect.runPromise(
      reopened.getTelegramMessageOrigin({ chatId: 10, messageId: 20 }),
    ),
    "worker-a",
  )
  assert.equal(
    await Effect.runPromise(
      reopened.getTelegramMessageOrigin({ chatId: 11, messageId: 20 }),
    ),
    "worker-b",
  )
  assert.equal(
    await Effect.runPromise(
      reopened.getTelegramMessageOrigin({ chatId: 10, messageId: 21 }),
    ),
    undefined,
  )
})

test("repeated receipt binding is idempotent but cannot be reassigned to another agent", async t => {
  const { store } = fixture(t)
  const binding = { agentId: "worker-a", chatId: 10, messageId: 20 }
  await Effect.runPromise(store.linkTelegramMessageOrigin(binding))
  await Effect.runPromise(store.linkTelegramMessageOrigin(binding))
  const changed = await Effect.runPromise(
    Effect.either(
      store.linkTelegramMessageOrigin({ ...binding, agentId: "worker-b" }),
    ),
  )
  assert.ok(Either.isLeft(changed))
  assert.equal(
    await Effect.runPromise(store.getTelegramMessageOrigin(binding)),
    "worker-a",
  )
})

test("malformed reply addresses cannot acquire or read an origin binding", async t => {
  const { store } = fixture(t)
  for (const address of [
    { chatId: 0, messageId: 1 },
    { chatId: 1, messageId: 0 },
    { chatId: 1, messageId: 1.5 },
  ]) {
    assert.ok(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(
            store.linkTelegramMessageOrigin({ agentId: "worker", ...address }),
          ),
        ),
      ),
    )
    assert.ok(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(store.getTelegramMessageOrigin(address)),
        ),
      ),
    )
  }
})
