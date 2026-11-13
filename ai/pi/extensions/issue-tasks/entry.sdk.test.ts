import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  getPackageDir,
  SessionManager,
  SettingsManager,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent"
import type { TaskToolDetails } from "./tool.ts"

const parent = fileURLToPath(
  new URL("../../../../.tmp/issue-task-host-tests/", import.meta.url),
)
const extensionDirectory = fileURLToPath(new URL("./", import.meta.url))

const extensionPackage = fileURLToPath(new URL("../", import.meta.url))

const configuredSettings = JSON.parse(
  readFileSync(new URL("../../../pi.settings.json", import.meta.url), "utf8"),
)

test("actual SDK discovers the configured task tool and executes persisted task work", async () => {
  const packageRoot = getPackageDir()
  const loader = await import(
    pathToFileURL(join(packageRoot, "dist/core/extensions/loader.js")).href
  )
  const runnerModule = await import(
    pathToFileURL(join(packageRoot, "dist/core/extensions/runner.js")).href
  )
  const busModule = await import(
    pathToFileURL(join(packageRoot, "dist/core/event-bus.js")).href
  )
  const validation = await import(
    pathToFileURL(
      join(
        packageRoot,
        "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
      ),
    ).href
  )
  const packageManager = await import(
    pathToFileURL(join(packageRoot, "dist/core/package-manager.js")).href
  )
  const runtime = loader.createExtensionRuntime()

  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "sdk-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  let runner: InstanceType<typeof runnerModule.ExtensionRunner> | undefined

  try {
    assert.ok(configuredSettings.packages.includes(resolve(extensionPackage)))

    const packages = new packageManager.DefaultPackageManager({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.inMemory(),
    })

    const resources = await packages.resolveExtensionSources(
      [extensionPackage],
      {
        temporary: true,
      },
    )

    const taskResource = resources.extensions.find(
      resource => resource.path === join(extensionDirectory, "index.ts"),
    )

    assert.equal(taskResource?.enabled, true, "configured package exposes task")
    assert.ok(taskResource)
    const loaded = await loader.loadExtensions(
      [taskResource.path],
      root,
      busModule.createEventBus(),
      runtime,
    )

    assert.deepEqual(loaded.errors, [])
    assert.equal(loaded.extensions.length, 1)
    const activeRunner = new runnerModule.ExtensionRunner(
      loaded.extensions,
      runtime,
      root,
      SessionManager.inMemory(root),
      {} as ModelRegistry,
    )
    runner = activeRunner
    const errors: unknown[] = []
    activeRunner.onError((error: unknown) => {
      errors.push(error)
    })
    assert.equal(activeRunner.getToolDefinition("task"), undefined)
    await activeRunner.emit({ type: "session_start" })
    const registered = activeRunner.getToolDefinition("task")

    assert.ok(registered)
    const issue = { repository: "owner/repo", number: 7 }

    const invoke = async (id: string, arguments_: unknown) => {
      const context = activeRunner.createToolContext(id, undefined)
      const params = validation.validateToolArguments(registered, {
        type: "toolCall",
        id,
        name: "task",
        arguments: arguments_,
      })
      return registered.execute(id, params, undefined, undefined, context)
    }

    const add = {
      action: "apply",
      issues: [issue],
      operations: [
        { op: "add", issue, key: "one", text: "SDK task requirement" },
      ],
    }
    const first = (await invoke("sdk-write", add)).details as TaskToolDetails
    const replay = (await invoke("sdk-write", add)).details as TaskToolDetails

    assert.ok(first.outcome.kind === "saved")
    assert.ok(replay.outcome.kind === "saved")
    assert.equal(first.outcome.result.receipt, "committed")
    assert.equal(replay.outcome.result.receipt, "replayed")
    const read = { action: "read", issue, page: { limit: 10 } }
    const page = (await invoke("sdk-read", read)).details as TaskToolDetails

    assert.ok(page.outcome.kind === "page")
    assert.equal(page.outcome.page.tasks.length, 1)
    await activeRunner.emit({ type: "session_shutdown" })
    const closed = (await invoke("sdk-after-shutdown", read))
      .details as TaskToolDetails

    assert.ok(closed.outcome.kind === "failed")
    assert.equal(closed.outcome.code, "closed")
    assert.deepEqual(errors, [])
  } finally {
    try {
      if (runner !== undefined) await runner.emit({ type: "session_shutdown" })
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      rmSync(root, { recursive: true })
    }
  }
})
