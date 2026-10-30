import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, type FSWatcher } from "node:fs"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mock } from "node:test"
import { fileURLToPath } from "node:url"
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent"
import { managedPiWatchPaths } from "../core.ts"

const root = process.argv[2]
const scenario = process.argv[3]
assert.ok(
  typeof root === "string" &&
    (scenario === "notice" || scenario === "stale" || scenario === "bounded"),
)
assert.equal(homedir(), root)

const paths = managedPiWatchPaths(join(root, ".config", "ai"))
for (const path of paths) {
  if (path.endsWith(".md") || path.endsWith(".json")) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, path.endsWith(".json") ? "{}" : "Fixture instructions")
  } else mkdirSync(path, { recursive: true })
}

const cwd = join(root, "project")
mkdirSync(cwd)

const watched: unknown[] = []
const closed: string[] = []
const attempts: unknown[] = []
const messages: unknown[] = []
const logs: string[] = []
const emitted: string[] = []
const notifications: string[] = []
const require = createRequire(import.meta.url)
const fs: typeof import("node:fs") = require("node:fs")
const watchMock = mock.method(fs, "watch", (path: string, options: unknown) => {
  watched.push({ path, options })

  if (path === paths[0])
    throw new Error(
      scenario === "bounded" ? `\u001b\n${"x".repeat(400)}` : "probe failed",
    )

  const watcher = {
    close: () => {
      closed.push(path)
    },
  } satisfies Pick<FSWatcher, "close">

  return watcher
})
const logMock = mock.method(console, "error", (message: string) => {
  logs.push(message)
})
syncBuiltinESMExports()

type Hook = (event: unknown, ctx: ExtensionContext) => unknown
const hooks = new Map<string, Set<Hook>>()
const ui = {
  setStatus: () => {},
  notify: (message: string) => {
    notifications.push(message)
  },
  getEditorText: () => "",
  setEditorText: () => {},
} satisfies Pick<
  ExtensionUIContext,
  "setStatus" | "notify" | "getEditorText" | "setEditorText"
>
const sessionManager = {
  getBranch: () => [],
  getSessionFile: () => undefined,
} satisfies Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getSessionFile"
>
const partialUi: Partial<ExtensionUIContext> = ui
const partialSession: Partial<ExtensionContext["sessionManager"]> =
  sessionManager
const context = {
  cwd,
  mode: "print",
  hasUI: false,
  isIdle: () => false,
  hasPendingMessages: () => false,
  ui: partialUi as ExtensionUIContext,
  sessionManager: partialSession as ExtensionContext["sessionManager"],
} satisfies Partial<ExtensionContext>
const ctx = context as ExtensionContext
const on: ExtensionAPI["on"] = (name, callback) => {
  const callbacks = hooks.get(name) ?? new Set()
  callbacks.add(callback as unknown as Hook)
  hooks.set(name, callbacks)

  return () => {
    callbacks.delete(callback as unknown as Hook)
  }
}
const pi = {
  on,
  registerMessageRenderer: () => {},
  registerCommand: () => {},
  events: {
    on: () => () => {},
    emit: (name: string) => {
      emitted.push(name)
    },
  },
  sendMessage: (message, options) => {
    attempts.push({ message, options })

    if (scenario === "stale") throw new Error("sensitive sender sentinel")

    messages.push({ message, options })
  },
} satisfies Pick<
  ExtensionAPI,
  | "on"
  | "registerMessageRenderer"
  | "registerCommand"
  | "events"
  | "sendMessage"
>
const dispatch = async (name: string, event: unknown) => {
  const callbacks = hooks.get(name)
  assert.equal(callbacks?.size, 1, `Actual ${name} registration`)
  assert.ok(callbacks)

  for (const callback of callbacks) await callback(event, ctx)
}

try {
  const support: unknown = await import(
    new URL("../../../../test/pi-host-test-support.mjs", import.meta.url).href
  )

  assert.ok(
    typeof support === "object" &&
      support !== null &&
      "loadHostExtension" in support &&
      typeof support.loadHostExtension === "function",
  )

  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
  )

  assert.ok(typeof factory === "function")

  const partialHost: Partial<ExtensionAPI> = pi
  factory(partialHost as ExtensionAPI)

  await dispatch("session_start", { reason: "startup" })
} finally {
  if (hooks.has("session_shutdown")) await dispatch("session_shutdown", {})

  watchMock.mock.restore()
  logMock.mock.restore()
  syncBuiltinESMExports()
}

assert.deepEqual(
  watched,
  paths.map(path => ({
    path,
    options: { recursive: !path.endsWith(".md") && !path.endsWith(".json") },
  })),
)
assert.deepEqual(closed, paths.slice(1))
assert.deepEqual(emitted, [])

process.stdout.write(
  JSON.stringify({ attempts, messages, logs, notifications }),
)
