import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { getManagerBinding, registerManagerBinding } from "./manager-binding.ts"

test("actual Pi SDK keeps manager flags extension-private while scoped binding reaches the todo API", async () => {
  const root = getPackageDir()
  const loader = await import(
    pathToFileURL(join(root, "dist", "core", "extensions", "loader.js")).href
  )
  const busModule = await import(
    pathToFileURL(join(root, "dist", "core", "event-bus.js")).href
  )
  const runtime = loader.createExtensionRuntime()
  const bus = busModule.createEventBus()
  let owner: ExtensionAPI | undefined
  let todo: ExtensionAPI | undefined
  await loader.loadExtensionFromFactory(
    (pi: ExtensionAPI) => {
      owner = pi
      pi.registerFlag("manager-worker", {
        type: "string",
        description: "Test manager binding",
      })
      registerManagerBinding(pi, sessionId => {
        if (sessionId !== "manager-session") return undefined
        const workerSessionId = pi.getFlag("manager-worker")
        return typeof workerSessionId === "string"
          ? { role: "manager", workerSessionId }
          : undefined
      })
    },
    process.cwd(),
    bus,
    runtime,
    "manager-binding-owner.test",
  )
  await loader.loadExtensionFromFactory(
    (pi: ExtensionAPI) => {
      todo = pi
    },
    process.cwd(),
    bus,
    runtime,
    "manager-binding-todo.test",
  )
  runtime.flagValues.set("manager-worker", "worker-123")
  assert.ok(owner)
  assert.ok(todo)
  assert.equal(owner.getFlag("manager-worker"), "worker-123")
  assert.equal(todo.getFlag("manager-worker"), undefined)
  const ctx = {
    sessionManager: {
      getSessionId: () => "manager-session",
      getBranch: () => [],
    },
  } as unknown as ExtensionContext
  assert.deepEqual(
    getManagerBinding(todo, ctx),
    Either.right({ role: "manager", workerSessionId: "worker-123" }),
  )
})
