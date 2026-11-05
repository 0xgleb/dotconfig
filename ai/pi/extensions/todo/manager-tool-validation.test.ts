import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
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
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>
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
    test(`actual SDK -> registered manager tool -> signed worker request (effort capability ${effortSupported}): ${operation.action} ${"priority" in operation ? operation.priority : ""}`, async t => {
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
      state.right.publish({
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
      let calls = 0
      factory(pi, {
        agentDir: root,
        timeoutMs: 1000,
        wait: async () => {
          state.right.processPriorities(
            () => "rev",
            () => assert.fail("wrong lane"),
            request => {
              calls += 1
              assert.deepEqual(request, operation)
              return Either.right(JSON.stringify(request))
            },
          )
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
      if (
        ("effort" in operation && !effortSupported) ||
        "unexpected" in operation ||
        (operation.action !== "priority" && "priority" in operation)
      ) {
        assert.equal(result.isError, true)
        assert.equal(calls, 0, "unsupported input must never reach the worker")
        return
      }
      assert.notEqual(
        result.isError,
        true,
        result.content.map(part => part.text).join("\n"),
      )
      assert.equal(calls, 1)
      assert.deepEqual(JSON.parse(result.content[0]!.text), operation)
    })
  }
