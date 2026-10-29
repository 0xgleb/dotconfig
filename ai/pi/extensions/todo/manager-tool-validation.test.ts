import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import {
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { loadHostExtension } from "../../../test/pi-host-test-support.mjs"
import { registerManagerBinding } from "../shared/manager-binding.ts"
import { managerPairDirectory } from "../classified-workflows/manager-session-core.ts"
import { prepareNativeManagerState } from "../classified-workflows/manager-native-state.ts"

const factory = await loadHostExtension(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
)

const { validateToolArguments } = await import(
  pathToFileURL(
    join(
      getPackageDir(),
      "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
    ),
  ).href
)

interface CapturedTool {
  readonly name: string
  readonly parameters: unknown
  readonly execute: (
    id: string,
    args: unknown,
    signal: undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    readonly isError?: boolean
    readonly content: { readonly text: string }[]
    readonly details?: unknown
  }>
}

for (const effortSupported of [true, false])
  for (const operation of [
    { action: "effort", id: 279, effort: 3 },
    { action: "effort", id: 279, effort: null },
    { action: "add", text: "Estimated delivery", effort: 5 },
    { action: "priority", id: 279, priority: null },
    { action: "priority", id: 279, priority: 1 },
    { action: "reply", id: 265, text: "Inspect exact state before retrying." },
    { action: "list" },
    { action: "list", priority: 4 },
    { action: "list", unexpected: "unsupported field" },
  ]) {
    test(`actual SDK -> registered manager tool fails closed (effort capability ${effortSupported}): ${operation.action} ${"priority" in operation ? operation.priority : ""}`, async t => {
      const root = mkdtempSync(join(tmpdir(), "pi-manager-tool-validation-"))
      t.after(() => rmSync(root, { recursive: true }))

      const scope = { workerSessionId: "worker", cwd: "/projects/worker" }
      const directory = managerPairDirectory({
        agentDir: root,
        workerSessionId: scope.workerSessionId,
        workerCwd: scope.cwd,
      })

      assert.ok(Either.isRight(directory))

      const state = prepareNativeManagerState(directory.right, scope)

      assert.ok(Either.isRight(state))

      const published = state.right.publish({
        ...scope,
        version: 1,
        observedAt: Date.now(),
        priorityRevision: "rev",
        data: {
          todoControl: true,
          todoPriorityControl: true,
          ...(effortSupported ? { todoEffortControl: true } : {}),
        },
      })

      assert.ok(Either.isRight(published))

      const listeners = new Map<string, ((value: unknown) => void)[]>()
      let tool: CapturedTool | undefined

      const pi = {
        events: {
          on: (name: string, listener: (value: unknown) => void) => {
            listeners.set(name, [...(listeners.get(name) ?? []), listener])

            return () => {}
          },
          emit: (name: string, value: unknown) => {
            for (const listener of listeners.get(name) ?? []) listener(value)
          },
        },
        on: () => {},
        registerCommand: () => {},
        registerShortcut: () => {},
        registerTool: (definition: CapturedTool) => {
          tool = definition
        },
        appendEntry: () => assert.fail("manager-local task mutation"),
      } as unknown as ExtensionAPI

      registerManagerBinding(pi, id =>
        id === "manager"
          ? {
              role: "manager",
              workerSessionId: scope.workerSessionId,
              workerCwd: scope.cwd,
            }
          : undefined,
      )

      const ctx = {
        cwd: "/global/manager",
        sessionManager: { getSessionId: () => "manager", getBranch: () => [] },
      } as unknown as ExtensionContext

      let polls = 0

      factory(pi, {
        agentDir: root,
        timeoutMs: 1000,
        wait: async () => {
          polls += 1
          assert.fail("Unavailable manager requests must not poll for receipts")
        },
      })

      assert.ok(tool)

      const input = {
        text: null,
        id: null,
        parentId: null,
        priority: null,
        effort: null,
        status: null,
        reason: null,
        remindAt: null,
        ...operation,
      }

      const validated = validateToolArguments(tool, {
        type: "toolCall",
        id: "call",
        name: "todo",
        arguments: input,
      })

      const result = await tool.execute(
        "call",
        validated,
        undefined,
        undefined,
        ctx,
      )

      assert.equal(result.isError, true)
      assert.deepEqual(result.details, { outcome: "unavailable" })
      assert.equal(polls, 0)
      assert.deepEqual(readdirSync(join(directory.right, "requests")), [])

      const message = result.content.map(part => part.text).join("\n")

      if ("effort" in operation && !effortSupported) {
        assert.match(message, /not loaded effort control/u)
        return
      }

      if (
        "unexpected" in operation ||
        (operation.action !== "priority" && "priority" in operation)
      ) {
        assert.match(message, /Malformed worker task request/u)
        return
      }

      assert.match(message, /Queued manager calls are retired/u)
      assert.match(message, /\/projects\/worker/u)
      assert.match(message, /session worker/u)
    })
  }
