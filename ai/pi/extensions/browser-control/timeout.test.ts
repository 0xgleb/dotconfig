import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer, type RequestListener } from "node:http"
import test from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import browserControl from "./index.ts"

const browserSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

interface CapturedBrowserTool {
  readonly execute: (
    toolCallId: string,
    params: { readonly action: "fetch"; readonly url: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ) => Promise<unknown>
}

const captureBrowserTool = (): CapturedBrowserTool => {
  let captured: CapturedBrowserTool | undefined
  const pi = {
    events: { on: () => {}, emit: () => {} },
    on: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerTool: (candidate: { readonly name: string }) => {
      if (candidate.name === "browser")
        captured = candidate as unknown as CapturedBrowserTool
    },
  } as unknown as ExtensionAPI
  browserControl(pi)
  assert.ok(captured)
  return captured
}

const tool = captureBrowserTool()
const context = {
  ui: { setStatus: () => {} },
  sessionManager: { getBranch: () => [] },
}

const withLoopbackServer = async (
  listener: RequestListener,
  use: (url: string) => Promise<void>,
): Promise<void> => {
  const server = createServer(listener)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    await use(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test("hung loopback fetch bypasses page-indicator CDP preflight", () => {
  assert.match(
    browserSource,
    /const pageVisibleActivity = action === "open" \|\| action === "text"/,
  )
  assert.match(
    browserSource,
    /if \(pageVisibleActivity\) await queuePageActivity\(true\)/,
  )
})

test("a hung loopback fetch starts immediately and returns its typed timeout", async () => {
  let requests = 0
  await withLoopbackServer(
    () => {
      requests += 1
    },
    async url => {
      const startedAt = Date.now()
      await assert.rejects(
        tool.execute(
          "hung-loopback",
          { action: "fetch", url },
          undefined,
          undefined,
          context,
        ),
        error =>
          /Loopback API request timed out after 5000ms/.test(String(error)),
      )
      assert.equal(requests, 1)
      assert.ok(Date.now() - startedAt < 7_000)
    },
  )
})

test("a stalled loopback response body retains the typed timeout", async () => {
  await withLoopbackServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.write("partial")
    },
    async url => {
      await assert.rejects(
        tool.execute(
          "stalled-body",
          { action: "fetch", url },
          undefined,
          undefined,
          context,
        ),
        error =>
          /Loopback API response timed out after 5000ms/.test(String(error)),
      )
    },
  )
})

test("caller cancellation remains distinct from internal timeout", async () => {
  const controller = new AbortController()
  await withLoopbackServer(
    () => {
      setTimeout(() => controller.abort(), 10)
    },
    async url => {
      await assert.rejects(
        tool.execute(
          "cancelled-fetch",
          { action: "fetch", url },
          controller.signal,
          undefined,
          context,
        ),
        /Loopback API request was cancelled/,
      )
    },
  )
})

test("missing content type and oversized bodies fail closed", async () => {
  await withLoopbackServer(
    (_request, response) => response.end("untyped"),
    async url => {
      await assert.rejects(
        tool.execute(
          "missing-content-type",
          { action: "fetch", url },
          undefined,
          undefined,
          context,
        ),
        /content type is required/i,
      )
    },
  )
  await withLoopbackServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("x".repeat(60 * 1_024))
    },
    async url => {
      await assert.rejects(
        tool.execute(
          "oversized-body",
          { action: "fetch", url },
          undefined,
          undefined,
          context,
        ),
        /response exceeded.*byte limit/i,
      )
    },
  )
})
