import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs"
import { join } from "node:path"
import { Effect, Either } from "effect"
import {
  createManagerTaskAuthority,
  type ManagerTaskOperation,
  type ManagerTaskAuthority,
} from "./manager-task-protocol.ts"
import {
  startManagerTaskServer,
  callManagerTask,
  type ManagerTaskServer,
} from "./manager-task-rpc.ts"

const scope = { workerSessionId: "worker-123", cwd: "/projects/worker" }
const fixture = (t: test.TestContext) => {
  const directory = mkdtempSync("/tmp/pt-rpc-")
  let server: ManagerTaskServer | undefined
  t.after(async () => {
    if (server) await Effect.runPromise(server.close)
    rmSync(directory, { recursive: true })
  })
  const authority = createManagerTaskAuthority(scope, () =>
    Either.right("ab".repeat(32)),
  )
  let writes = 0
  const file = join(directory, "persisted.json")
  const start = async (
    revision = () => Either.right("revision-1"),
    options: { authority?: ManagerTaskAuthority; now?: () => number } = {},
  ) => {
    const opened = await Effect.runPromise(
      Effect.either(
        startManagerTaskServer({
          directory,
          authority,
          revision,
          ...options,
          invoke: operation => {
            writeFileSync(file, JSON.stringify(operation), { mode: 0o600 })
            writes += 1
            return Either.right("Actual persisted worker result")
          },
        }),
      ),
    )
    assert.ok(
      Either.isRight(opened),
      Either.isLeft(opened) ? opened.left.message : "",
    )
    server = opened.right
    return server
  }
  const call = (
    operation: ManagerTaskOperation,
    overrides: {
      signal?: AbortSignal
      timeoutMs?: number
      authority?: ManagerTaskAuthority
    } = {},
  ) =>
    Effect.runPromise(
      Effect.either(
        callManagerTask({
          directory,
          scope,
          authority,
          operation,
          timeoutMs: 1000,
          ...overrides,
        }),
      ),
    )
  return { directory, authority, start, call, file, writes: () => writes }
}

test("a deadline consumed during signing fails before sending a worker command", async t => {
  const f = fixture(t)
  await f.start()
  const authority: ManagerTaskAuthority = {
    ...f.authority,
    command: (...args) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
      return f.authority.command(...args)
    },
  }
  const result = await f.call(
    { kind: "todo", request: { action: "clear" } },
    { authority, timeoutMs: 50 },
  )
  assert.ok(Either.isLeft(result))
  assert.equal(
    result.left.code,
    "unavailable",
    "expired signing never becomes a possibly dispatched call",
  )
  assert.equal(f.writes(), 0)
})

test("a deadline crossed during worker authentication prevents invocation", async t => {
  const f = fixture(t)
  let at = 1000
  const authority: ManagerTaskAuthority = {
    ...f.authority,
    readCommand: (...args) => {
      const result = f.authority.readCommand(...args)
      at = 3000
      return result
    },
  }
  await f.start(undefined, { authority, now: () => at })
  const result = await f.call({ kind: "todo", request: { action: "clear" } })
  assert.ok(Either.isRight(result))
  assert.equal(result.right.outcome, "failed")
  assert.equal(f.writes(), 0)
})

test("a direct task call returns only the actual worker result after persistence", async t => {
  const f = fixture(t)
  const server = await f.start()
  const operation: ManagerTaskOperation = {
    kind: "todo",
    request: { action: "effort", id: 55, effort: 5 },
  }
  const result = await f.call(operation)
  assert.ok(Either.isRight(result))
  assert.equal(result.right.outcome, "completed")
  assert.equal(result.right.message, "Actual persisted worker result")
  assert.equal(f.writes(), 1)
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), operation)
  assert.equal(
    readdirSync(f.directory).some(name => /requests|receipts/u.test(name)),
    false,
  )
  await Effect.runPromise(server.close)
  assert.equal(existsSync(join(f.directory, "task.sock")), false)
})

test("missing workers fail without saving a request for later execution", async t => {
  const f = fixture(t)
  const result = await f.call({
    kind: "todo",
    request: { action: "add", text: "Must not execute later" },
  })
  assert.ok(Either.isLeft(result))
  assert.equal(f.writes(), 0)
  assert.deepEqual(readdirSync(f.directory), [])
  await f.start()
  assert.equal(f.writes(), 0)
})

test("abort before dispatch and a stale worker revision cannot mutate the worker", async t => {
  const f = fixture(t)
  let reads = 0
  await f.start(() => Either.right(++reads === 1 ? "revision-1" : "revision-2"))
  const controller = new AbortController()
  controller.abort()
  const cancelled = await f.call(
    { kind: "todo", request: { action: "clear" } },
    { signal: controller.signal },
  )
  assert.ok(Either.isLeft(cancelled))
  const stale = await f.call({ kind: "todo", request: { action: "clear" } })
  assert.ok(Either.isRight(stale))
  assert.equal(stale.right.outcome, "failed")
  assert.equal(f.writes(), 0)
})

test("another authority cannot cause a worker operation and endpoint ownership is exclusive", async t => {
  const f = fixture(t)
  await f.start()
  const wrong = createManagerTaskAuthority(scope, () =>
    Either.right("cd".repeat(32)),
  )
  const result = await Effect.runPromise(
    Effect.either(
      callManagerTask({
        directory: f.directory,
        scope,
        authority: wrong,
        operation: { kind: "todo", request: { action: "clear" } },
        timeoutMs: 1000,
      }),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(f.writes(), 0)
  const duplicate = await Effect.runPromise(
    Effect.either(
      startManagerTaskServer({
        directory: f.directory,
        authority: f.authority,
        revision: () => Either.right("revision-1"),
        invoke: () => Either.right("Must not replace worker"),
      }),
    ),
  )
  assert.ok(Either.isLeft(duplicate))
  const valid = await f.call({ kind: "priorities", text: "55 16" })
  assert.ok(Either.isRight(valid))
  assert.equal(valid.right.outcome, "completed")
})
