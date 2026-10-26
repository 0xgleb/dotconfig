import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import {
  createManagerTaskAuthority,
  type ManagerTaskOperation,
} from "./manager-task-protocol.ts"
import { ManagerSessionError } from "./manager-session-core.ts"

const scope = { workerSessionId: "worker-123", cwd: "/projects/worker" }
const authority = () =>
  createManagerTaskAuthority(scope, () => Either.right("ab".repeat(32)))
const handshake = () => {
  const auth = authority()
  const hello = auth.hello("connection-1", "revision-1", 2000)
  assert.ok(Either.isRight(hello))
  return { auth, hello: hello.right }
}

test("direct task calls authenticate worker, connection, revision and actual completed result", () => {
  for (const operation of [
    { kind: "todo", request: { action: "effort", id: 55, effort: 5 } },
    { kind: "todo", request: { action: "priority", id: 55, priority: null } },
    { kind: "priorities", text: "55 16" },
  ] satisfies ManagerTaskOperation[]) {
    const { auth, hello } = handshake()
    assert.deepEqual(auth.readHello(hello), Either.right(hello))
    const command = auth.command(hello, "call-1", operation, 1500)
    assert.ok(Either.isRight(command))
    assert.deepEqual(
      auth.readCommand(command.right, hello, "revision-1", 1000),
      command,
    )
    const result = auth.response(command.right, {
      outcome: "completed",
      message: "Persisted worker result",
    })
    assert.ok(Either.isRight(result))
    assert.deepEqual(auth.readResponse(result.right, command.right), result)
  }
})

test("wrong worker, connection, revision, signature or expired commands cannot authorize dispatch", () => {
  const { auth, hello } = handshake()
  const signed = auth.command(
    hello,
    "call-1",
    { kind: "todo", request: { action: "list" } },
    1500,
  )
  assert.ok(Either.isRight(signed))
  for (const changed of [
    { ...signed.right, workerSessionId: "foreign" },
    { ...signed.right, cwd: "/foreign" },
    { ...signed.right, nonce: "another-connection" },
    { ...signed.right, signature: "00".repeat(32) },
    {
      ...signed.right,
      operation: { kind: "todo", request: { action: "clear" } },
    },
    { ...signed.right, unexpected: true },
  ])
    assert.ok(
      Either.isLeft(auth.readCommand(changed, hello, "revision-1", 1000)),
    )
  assert.ok(
    Either.isLeft(auth.readCommand(signed.right, hello, "changed", 1000)),
  )
  assert.ok(
    Either.isLeft(auth.readCommand(signed.right, hello, "revision-1", 1500)),
  )
  assert.ok(
    Either.isLeft(auth.readCommand(signed.right, hello, "revision-1", NaN)),
  )
})

test("unsupported operations and false queued success are rejected as typed protocol failures", () => {
  const { auth, hello } = handshake()
  const signed = auth.command(
    hello,
    "call-1",
    { kind: "todo", request: { action: "list" } },
    1500,
  )
  assert.ok(Either.isRight(signed))
  for (const value of [
    null,
    {},
    { ...signed.right, operation: { kind: "shell", text: "unsupported" } },
    {
      ...signed.right,
      operation: {
        kind: "todo",
        request: { action: "effort", id: 55, effort: 4 },
      },
    },
  ])
    assert.ok(Either.isLeft(auth.readCommand(value, hello, "revision-1", 1000)))
  const response = auth.response(signed.right, {
    outcome: "completed",
    message: "Actual result",
  })
  assert.ok(Either.isRight(response))
  assert.ok(
    Either.isLeft(
      auth.readResponse(
        {
          ...response.right,
          result: { outcome: "queued", message: "Not executed" },
        },
        signed.right,
      ),
    ),
  )
  assert.ok(
    Either.isLeft(
      auth.readResponse(
        { ...response.right, id: "another-request" },
        signed.right,
      ),
    ),
  )
})

test("unavailable authority fails closed without fabricating credentials or a result", () => {
  const auth = createManagerTaskAuthority(scope, () =>
    Either.left(
      new ManagerSessionError({
        code: "unavailable",
        message: "Private authority unavailable",
      }),
    ),
  )
  const result = auth.hello("connection", "revision", 2000)
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.message, "Private authority unavailable")
})
