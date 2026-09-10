import assert from "node:assert/strict"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { Effect, Either } from "effect"

import {
  languageServerEnvironment,
  LspClientError,
  LanguageClientPool,
  startLanguageClient,
  type LspProcessFactory,
} from "./client.ts"
import { SERVER_PROFILES } from "./servers.ts"

const frame = (message: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ])
}

interface RpcMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
}

const fakeProcessFactory = (
  handler: (message: RpcMessage, send: (message: unknown) => void) => void,
) => {
  const received: RpcMessage[] = []
  let activeChild: (EventEmitter & { exitCode: number | null }) | undefined
  let killed = false
  let spawnCount = 0
  let spawnInput:
    | {
        readonly command: string
        readonly args: readonly string[]
        readonly cwd?: string
      }
    | undefined
  const factory: LspProcessFactory = {
    spawn: (command, args, options) => {
      spawnCount += 1
      spawnInput = {
        command,
        args,
        ...(options.cwd === undefined
          ? {}
          : {
              cwd:
                typeof options.cwd === "string"
                  ? options.cwd
                  : options.cwd.toString(),
            }),
      }
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const events = new EventEmitter()
      let buffer = Buffer.alloc(0)
      const send = (message: unknown) => stdout.write(frame(message))
      stdin.on("data", chunk => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)])
        while (true) {
          const headerEnd = buffer.indexOf("\r\n\r\n")
          if (headerEnd < 0) break
          const match = /Content-Length: (\d+)/iu.exec(
            buffer.subarray(0, headerEnd).toString("ascii"),
          )
          assert.ok(match?.[1])
          const length = Number(match[1])
          const start = headerEnd + 4
          if (buffer.length < start + length) break
          const message = JSON.parse(
            buffer.subarray(start, start + length).toString("utf8"),
          ) as RpcMessage
          buffer = buffer.subarray(start + length)
          received.push(message)
          handler(message, send)
        }
      })
      const child = Object.assign(events, {
        stdin,
        stdout,
        stderr,
        pid: 4242,
        exitCode: null as number | null,
        signalCode: null,
        killed: false,
        kill() {
          killed = true
          child.killed = true
          child.exitCode = 0
          events.emit("exit", 0, null)
          return true
        },
      })
      activeChild = child
      return child as unknown as ChildProcessWithoutNullStreams
    },
  }
  return {
    factory,
    received,
    get killed() {
      return killed
    },
    get spawnCount() {
      return spawnCount
    },
    get spawnInput() {
      return spawnInput
    },
    exit() {
      if (!activeChild) return
      activeChild.exitCode = 1
      activeChild.emit("exit", 1, null)
    },
  }
}

const typescript = SERVER_PROFILES.find(profile => profile.id === "typescript")!

test("language servers receive only allowlisted process environment", () => {
  assert.deepEqual(
    languageServerEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      OPENAI_API_KEY: "must-not-leak",
      GH_TOKEN: "must-not-leak",
    }),
    { PATH: "/bin", HOME: "/home/test" },
  )
})

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-client-"))
  const file = join(root, "source.ts")
  await writeFile(file, "const value = 1\n", "utf8")
  return { root, file }
}

test("initializes, synchronizes a document, and requests definition", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: true,
            codeActionProvider: true,
          },
        },
      })
    }
    if (message.method === "textDocument/definition") {
      send({ jsonrpc: "2.0", id: message.id, result: [] })
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )
  assert.deepEqual(fake.spawnInput, {
    command: "typescript-language-server",
    args: ["--stdio"],
    cwd: root,
  })

  assert.deepEqual(
    await Effect.runPromise(client.definition(file, { line: 0, character: 6 })),
    [],
  )
  assert.equal(
    fake.received.filter(message => message.method === "textDocument/didOpen")
      .length,
    1,
  )
  await client.dispose()
  assert.equal(fake.killed, true)
})

test("code actions request a non-empty UTF-16 symbol range", async () => {
  const { root, file } = await workspace()
  let observedParams: unknown
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, codeActionProvider: true },
        },
      })
    if (message.method === "textDocument/codeAction") {
      observedParams = message.params
      send({ jsonrpc: "2.0", id: message.id, result: [] })
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )

  assert.deepEqual(
    await Effect.runPromise(
      client.codeActions(file, { line: 0, character: 6 }, 5),
    ),
    [],
  )
  assert.deepEqual(observedParams, {
    textDocument: { uri: new URL(`file://${file}`).href },
    range: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 },
    },
    context: { diagnostics: [], triggerKind: 1 },
  })
  await client.dispose()
})

test("classifies standard rename rejection responses without losing metadata", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, renameProvider: true },
        },
      })
    if (message.method === "textDocument/rename")
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "No references found at position" },
      })
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )

  const result = await Effect.runPromise(
    Effect.either(client.rename(file, { line: 0, character: 6 }, "nextValue")),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "request_rejected")
  const metadata = result.left as typeof result.left & {
    readonly serverCode?: number
    readonly serverDiagnostic?: string
  }
  assert.equal(metadata.serverCode, -32602)
  assert.equal(metadata.serverDiagnostic, "No references found at position")
  await client.dispose()
})

test("keeps internal rename server errors as failures", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, renameProvider: true },
        },
      })
    if (message.method === "textDocument/rename")
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "Internal server error" },
      })
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )

  const result = await Effect.runPromise(
    Effect.either(client.rename(file, { line: 0, character: 6 }, "nextValue")),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "request_failed")
  await client.dispose()
})

test("returns only bounded published diagnostics after didOpen", async () => {
  const { root, file } = await workspace()
  const diagnostics = Array.from({ length: 250 }, (_value, index) => ({
    range: {
      start: { line: 0, character: index },
      end: { line: 0, character: index + 1 },
    },
    message: `diagnostic ${index}`,
  }))
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, definitionProvider: true },
        },
      })
    }
    if (message.method === "textDocument/didOpen") {
      const params = message.params as { textDocument: { uri: string } }
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: params.textDocument.uri, diagnostics },
      })
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )
  const result = await Effect.runPromise(client.diagnostics(file))
  assert.ok(Array.isArray(result))
  assert.equal(result.length, 200)
  assert.deepEqual(
    await Effect.runPromise(client.diagnostics(file)),
    result,
    "an unchanged open document must reuse its fresh published diagnostics",
  )
  await client.dispose()
})

test("initial diagnostics wait through ordinary project analysis latency", async () => {
  const { root, file } = await workspace()
  const expected = [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      message: "delayed diagnostic",
    },
  ]
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, definitionProvider: true },
        },
      })
    if (message.method === "textDocument/didOpen") {
      const params = message.params as { textDocument: { uri: string } }
      setTimeout(
        () =>
          send({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: {
              uri: params.textDocument.uri,
              diagnostics: expected,
            },
          }),
        1_750,
      )
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )

  const result = await Effect.runPromise(client.diagnostics(file))
  await client.dispose()
  assert.deepEqual(result, expected)
})

test("malformed diagnostics publications fail instead of appearing pending", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, definitionProvider: true },
        },
      })
    if (message.method === "textDocument/didOpen") {
      const params = message.params as { textDocument: { uri: string } }
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: params.textDocument.uri, diagnostics: {} },
      })
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
      diagnosticsWaitMs: 20,
    }),
  )

  const result = await Effect.runPromise(
    Effect.either(client.diagnostics(file)),
  )
  await client.dispose()
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "malformed_notification")
})

test("late diagnostics remain cached for a retry after pending", async () => {
  const { root, file } = await workspace()
  const expected = [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      message: "late diagnostic",
    },
  ]
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, definitionProvider: true },
        },
      })
    if (message.method === "textDocument/didOpen") {
      const params = message.params as { textDocument: { uri: string } }
      setTimeout(
        () =>
          send({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: {
              uri: params.textDocument.uri,
              diagnostics: expected,
            },
          }),
        35,
      )
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
      diagnosticsWaitMs: 20,
    }),
  )

  assert.equal(await Effect.runPromise(client.diagnostics(file)), undefined)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(await Effect.runPromise(client.diagnostics(file)), expected)
  await client.dispose()
})

test("unversioned diagnostics after didChange satisfy the next generation", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, definitionProvider: true },
        },
      })
    if (
      message.method === "textDocument/didOpen" ||
      message.method === "textDocument/didChange"
    ) {
      const params = message.params as { textDocument: { uri: string } }
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: params.textDocument.uri,
          diagnostics: [],
        },
      })
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )
  assert.deepEqual(await Effect.runPromise(client.diagnostics(file)), [])
  await writeFile(file, "const changed = 2\n", "utf8")
  assert.deepEqual(await Effect.runPromise(client.diagnostics(file)), [])
  await client.dispose()
})

test("code actions omit diagnostics from an older document version", async () => {
  const { root, file } = await workspace()
  let observedDiagnostics: unknown
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            codeActionProvider: true,
          },
        },
      })
    if (message.method === "textDocument/didOpen") {
      const params = message.params as { textDocument: { uri: string } }
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: params.textDocument.uri,
          diagnostics: [{ message: "old diagnostic" }],
        },
      })
    }
    if (message.method === "textDocument/codeAction") {
      const params = message.params as {
        context: { diagnostics: unknown }
      }
      observedDiagnostics = params.context.diagnostics
      send({ jsonrpc: "2.0", id: message.id, result: [] })
    }
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )

  assert.deepEqual(await Effect.runPromise(client.diagnostics(file)), [
    { message: "old diagnostic" },
  ])
  await writeFile(file, "const changed = 2\n", "utf8")
  await Effect.runPromise(
    client.codeActions(file, { line: 0, character: 6 }, 7),
  )
  assert.deepEqual(observedDiagnostics, [])
  await client.dispose()
})

test("closing a client fails a pending diagnostics wait", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { textDocumentSync: 1, definitionProvider: true },
        },
      })
    if (message.method === "textDocument/didOpen")
      queueMicrotask(() => fake.exit())
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )
  const result = await Effect.runPromise(
    Effect.either(client.diagnostics(file)),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "closed")
})

test("serializes concurrent synchronization for one document", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 2,
            definitionProvider: true,
            referencesProvider: true,
          },
        },
      })
    }
    if (
      message.method === "textDocument/definition" ||
      message.method === "textDocument/references"
    )
      send({ jsonrpc: "2.0", id: message.id, result: [] })
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )

  await Promise.all([
    Effect.runPromise(client.definition(file, { line: 0, character: 6 })),
    Effect.runPromise(client.references(file, { line: 0, character: 6 })),
  ])
  assert.equal(
    fake.received.filter(message => message.method === "textDocument/didOpen")
      .length,
    1,
  )
  await client.dispose()
})

test("non-RPC request failures retain a bounded cause diagnostic", async () => {
  const { root, file } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { capabilities: { textDocumentSync: 1 } },
      })
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const client = await Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
  )
  await rm(file)

  const failure = await Effect.runPromise(Effect.flip(client.diagnostics(file)))
  assert.ok(failure instanceof LspClientError)
  assert.equal(failure.code, "request_failed")
  assert.match(failure.message, /language server request failed.*ENOENT/is)
  assert.ok(failure.message.length <= 600)
  await client.dispose()
})

test("RPC process exit evicts a closed pooled client", async () => {
  const { root } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { capabilities: { textDocumentSync: 1 } },
      })
    if (message.method === "shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
  })
  const pool = new LanguageClientPool(fake.factory)
  await Effect.runPromise(pool.get(typescript, root))
  assert.equal(pool.status().length, 1)
  fake.exit()
  assert.equal(pool.status().length, 0)
  await Effect.runPromise(pool.get(typescript, root))
  assert.equal(fake.spawnCount, 2)
  await pool.dispose()
})

test("interrupted initialization terminates the owned process", async () => {
  const { root } = await workspace()
  const fake = fakeProcessFactory(() => {})
  const controller = new AbortController()
  const pending = Effect.runPromise(
    startLanguageClient({
      profile: typescript,
      root,
      processFactory: fake.factory,
    }),
    { signal: controller.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending)
  assert.equal(fake.killed, true)
})

test("failed initialization terminates the owned process", async () => {
  const { root } = await workspace()
  const fake = fakeProcessFactory((message, send) => {
    if (message.method === "initialize")
      send({ jsonrpc: "2.0", id: message.id, result: {} })
  })
  await assert.rejects(
    Effect.runPromise(
      startLanguageClient({
        profile: typescript,
        root,
        processFactory: fake.factory,
      }),
    ),
  )
  assert.equal(fake.killed, true)
})
