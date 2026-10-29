import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { RUNTIME_VERSION_REQUEST_EVENT } from "../shared/runtime-version.ts"

test("the default usage extension remains callable through the real host loader", async () => {
  const support: unknown = await import(
    new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
  )

  assert.ok(
    typeof support === "object" &&
      support !== null &&
      "loadHostExtension" in support &&
      typeof support.loadHostExtension === "function",
  )

  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )

  assert.ok(typeof factory === "function")

  const hooks: string[] = []
  const commands: string[] = []
  const tools: string[] = []
  const subscriptions: string[] = []
  const emissions: string[] = []
  const pi = {
    on: name => {
      hooks.push(name)
      return () => {}
    },
    events: {
      on: (name: string) => {
        subscriptions.push(name)
        return () => {}
      },
      emit: (name: string) => {
        emissions.push(name)
      },
    },
    registerTool: definition => {
      tools.push(definition.name)
    },
    registerCommand: name => {
      commands.push(name)
    },
  } satisfies Pick<
    ExtensionAPI,
    "on" | "events" | "registerTool" | "registerCommand"
  >

  factory(pi)

  assert.deepEqual(tools, ["usage_checkpoint"])
  assert.deepEqual(commands, ["usage-checkpoint", "throttle"])
  assert.ok(hooks.includes("session_start"))
  assert.ok(hooks.includes("session_shutdown"))
  assert.ok(subscriptions.includes(RUNTIME_VERSION_REQUEST_EVENT))
  assert.deepEqual(emissions, [])
})
