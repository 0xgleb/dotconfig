import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import test from "node:test"
import { Effect, Either } from "effect"

import { JsonRpcConnection } from "./json-rpc.ts"

const frame = (message: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ])
}

const decodeFrames = (buffer: Buffer): unknown[] => {
  const messages: unknown[] = []
  let pending = buffer
  while (pending.length > 0) {
    const headerEnd = pending.indexOf("\r\n\r\n")
    if (headerEnd < 0) break
    const match = /Content-Length: (\d+)/iu.exec(
      pending.subarray(0, headerEnd).toString("ascii"),
    )
    assert.ok(match?.[1])
    const length = Number(match[1])
    const start = headerEnd + 4
    if (pending.length < start + length) break
    messages.push(
      JSON.parse(pending.subarray(start, start + length).toString("utf8")),
    )
    pending = pending.subarray(start + length)
  }
  return messages
}

const harness = (
  options?: ConstructorParameters<typeof JsonRpcConnection>[2],
) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  output.on("data", chunk => written.push(Buffer.from(chunk)))
  const connection = new JsonRpcConnection(input, output, options)
  return { input, written, connection }
}

test("decodes fragmented and combined response frames", async () => {
  const { input, written, connection } = harness()
  const first = Effect.runPromise(connection.request("first", {}))
  const second = Effect.runPromise(connection.request("second", {}))
  await new Promise(resolve => setImmediate(resolve))
  const calls = decodeFrames(Buffer.concat(written)) as Array<{ id: number }>
  assert.equal(calls.length, 2)

  const combined = Buffer.concat([
    frame({ jsonrpc: "2.0", id: calls[0]?.id, result: { ok: 1 } }),
    frame({ jsonrpc: "2.0", id: calls[1]?.id, result: { ok: 2 } }),
  ])
  input.write(combined.subarray(0, 13))
  input.write(combined.subarray(13))

  assert.deepEqual(await first, { ok: 1 })
  assert.deepEqual(await second, { ok: 2 })
  connection.dispose("test complete")
})

test("rejects server-initiated workspace edits", async () => {
  const { input, written, connection } = harness()
  input.write(
    frame({
      jsonrpc: "2.0",
      id: "server-7",
      method: "workspace/applyEdit",
      params: { edit: { changes: {} } },
    }),
  )
  await new Promise(resolve => setImmediate(resolve))

  const responses = decodeFrames(Buffer.concat(written)) as Array<{
    id: string
    result: unknown
  }>
  assert.deepEqual(responses, [
    {
      jsonrpc: "2.0",
      id: "server-7",
      result: {
        applied: false,
        failureReason: "LSP edits require a digest-bound tool preview",
      },
    },
  ])
  connection.dispose("test complete")
})

test("malformed responses fail instead of becoming empty success", async () => {
  const { input, written, connection } = harness()
  const pending = Effect.runPromise(
    Effect.either(connection.request("malformed", {})),
  )
  await new Promise(resolve => setImmediate(resolve))
  const calls = decodeFrames(Buffer.concat(written)) as Array<{ id: number }>
  input.write(frame({ jsonrpc: "2.0", id: calls[0]?.id }))

  const result = await pending
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_message")
})

test("malformed response IDs and error objects fail the connection", async () => {
  for (const response of [
    { jsonrpc: "2.0", id: "wrong", result: null },
    { jsonrpc: "2.0", id: 1, error: { message: "missing code" } },
  ]) {
    const { input, connection } = harness()
    const pending = Effect.runPromise(
      Effect.either(connection.request("strict", {})),
    )
    input.write(frame(response))
    const result = await pending
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_message")
  }
})

test("preserves bounded server rejection metadata", async () => {
  const { input, written, connection } = harness()
  const pending = Effect.runPromise(
    Effect.either(connection.request("textDocument/rename", {})),
  )
  await new Promise(resolve => setImmediate(resolve))
  const calls = decodeFrames(Buffer.concat(written)) as Array<{ id: number }>
  input.write(
    frame({
      jsonrpc: "2.0",
      id: calls[0]?.id,
      error: {
        code: -32602,
        message: `No references\u0000 found at position ${"x".repeat(1_000)}`,
      },
    }),
  )

  const result = await pending
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "server_error")
  const metadata = result.left as typeof result.left & {
    readonly serverCode?: number
    readonly serverDiagnostic?: string
  }
  assert.equal(metadata.serverCode, -32602)
  assert.match(metadata.serverDiagnostic ?? "", /^No references found/u)
  assert.doesNotMatch(metadata.serverDiagnostic ?? "", /[\u0000-\u001f\u007f]/u)
  assert.ok((metadata.serverDiagnostic?.length ?? 0) <= 500)
  connection.dispose("test complete")
})

test("oversized server frames fail pending requests", async () => {
  const { input, connection } = harness({ maxMessageBytes: 64 })
  const pending = Effect.runPromise(
    Effect.either(connection.request("oversized", {})),
  )
  input.write(Buffer.from("Content-Length: 65\r\n\r\n", "ascii"))

  const result = await pending
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "message_too_large")
})

test("request timeout sends cancellation and settles once", async () => {
  const { written, connection } = harness()
  const result = await Effect.runPromise(
    Effect.either(connection.request("slow", {}, { timeoutMs: 10 })),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "timeout")
  const messages = decodeFrames(Buffer.concat(written)) as Array<{
    id?: number
    method?: string
    params?: { id?: number }
  }>
  const request = messages.find(message => message.method === "slow")
  const cancellation = messages.find(
    message => message.method === "$/cancelRequest",
  )
  assert.equal(cancellation?.params?.id, request?.id)
  connection.dispose("test complete")
})
