import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  getPackageDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Extension,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"

import agentWorkspace from "./index.ts"

test("registered workspace status returns its validated profile without launching panes", async t => {
  const previous = process.env.ZELLIJ_SESSION_NAME
  process.env.ZELLIJ_SESSION_NAME = "workspace-status-fixture"
  t.after(() => {
    if (previous === undefined) delete process.env.ZELLIJ_SESSION_NAME
    else process.env.ZELLIJ_SESSION_NAME = previous
  })

  const runtime = createExtensionRuntime()
  const loader = await import(
    pathToFileURL(join(getPackageDir(), "dist/core/extensions/loader.js")).href
  )
  let panes: readonly { pane_name: string }[] = []
  const commands: string[] = []
  const extension: Extension = await loader.loadExtensionFromFactory(
    (pi: ExtensionAPI) =>
      agentWorkspace({
        ...pi,
        exec: async (command, args) => {
          commands.push(command)
          assert.equal(command, "zellij")
          assert.deepEqual(args, ["action", "list-panes", "--json"])
          return {
            stdout: JSON.stringify(panes),
            stderr: "",
            code: 0,
            killed: false,
          }
        },
      }),
    "/project",
    createEventBus(),
    runtime,
    "workspace-status-execute.test",
  )
  const registry = new ModelRegistry(
    await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }),
  )
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    "/project",
    SessionManager.inMemory("/project"),
    registry,
  )
  const registered = extension.tools.get("agent_workspace")
  assert.ok(registered)

  for (const status of ["stopped", "running"] as const) {
    panes =
      status === "running" ? [{ pane_name: "claude-personal-review" }] : []
    const result = await registered.definition.execute(
      status,
      { action: "status", profile: "personal-review" },
      undefined,
      undefined,
      runner.createToolContext(status, undefined),
    )
    assert.deepEqual(result.details, {
      profile: "personal-review",
      paneName: "claude-personal-review",
      status,
    })
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: `personal-review: ${status} in Zellij pane claude-personal-review`,
      },
    ])
  }
  assert.deepEqual(commands, ["zellij", "zellij"])
})
