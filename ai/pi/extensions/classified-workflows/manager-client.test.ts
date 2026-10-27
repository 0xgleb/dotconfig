import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { managerPairDirectory } from "./manager-session-core.ts"
import { prepareNativeManagerState } from "./manager-native-state.ts"
import { invokeManagerTodo } from "./manager-client.ts"
import { registerManagerBinding } from "../shared/manager-binding.ts"

interface WorkerOptions {
  readonly taskControl?: boolean
  readonly priorityControl?: boolean
  readonly effortControl?: boolean
  readonly managerCwd?: string
}

const fixture = (t: test.TestContext, options: WorkerOptions = {}) => {
  const root = mkdtempSync(join(tmpdir(), "pi-manager-client-test-"))
  t.after(() => rmSync(root, { recursive: true }))
  const scope = { workerSessionId: "worker", cwd: "/projects/worker" }
  const directory = managerPairDirectory({
    workerSessionId: scope.workerSessionId,
    workerCwd: scope.cwd,
    agentDir: root,
  })
  assert.ok(Either.isRight(directory))
  const state = prepareNativeManagerState(directory.right, scope)
  assert.ok(Either.isRight(state))
  assert.ok(
    Either.isRight(
      state.right.publish({
        ...scope,
        version: 1,
        observedAt: Date.now(),
        priorityRevision: "revision-1",
        data: {
          todoControl: options.taskControl ?? true,
          todoPriorityControl: options.priorityControl ?? true,
          todoEffortControl: options.effortControl ?? true,
        },
      }),
    ),
  )
  const handlers = new Map<string, ((value: unknown) => void)[]>()
  const pi = {
    getFlag: () => undefined,
    events: {
      on: (name: string, handler: (value: unknown) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
        return () => {}
      },
      emit: (name: string, value: unknown) => {
        for (const handler of handlers.get(name) ?? []) handler(value)
      },
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: options.managerCwd ?? scope.cwd,
    sessionManager: {
      getSessionId: () => "manager-session",
      getBranch: () => [],
    },
  } as unknown as ExtensionContext
  registerManagerBinding(pi, id =>
    id === "manager-session"
      ? {
          role: "manager",
          workerSessionId: scope.workerSessionId,
          workerCwd: scope.cwd,
        }
      : undefined,
  )
  const runtime = {
    agentDir: root,
    timeoutMs: 0,
    wait: async () => assert.fail("An unavailable mutation must not poll"),
  }
  return { pi, ctx, state: state.right, runtime }
}

for (const managerCwd of ["/projects/worker", "/global/manager"])
  test(`manager task calls fail closed for the selected worker from ${managerCwd}`, async t => {
    const worker = fixture(t, { managerCwd })
    for (const request of [
      { action: "list" },
      { action: "add", text: "Do not dispatch" },
      { action: "priority", id: 1, priority: 2 },
      { action: "effort", id: 1, effort: 5 },
    ] as const) {
      const result = await invokeManagerTodo(
        worker.pi,
        worker.ctx,
        request,
        undefined,
        worker.runtime,
      )

      assert.equal(result.isError, true)
      assert.deepEqual(result.details, { outcome: "unavailable" })
      const first = result.content[0]
      assert.ok(first)
      assert.match(first.text, /\/projects\/worker/u)
      assert.match(first.text, /session worker/u)
    }
    assert.deepEqual(
      worker.state.processPriorities(
        () => assert.fail("No revision may be read"),
        () => assert.fail("No priority mutation may execute"),
        () => assert.fail("No task mutation may execute"),
      ),
      Either.right([]),
    )
  })

for (const [option, request, message] of [
  ["taskControl", { action: "clear" }, /task control/u],
  [
    "priorityControl",
    { action: "priority", id: 1, priority: 2 },
    /priority control/u,
  ],
  ["effortControl", { action: "effort", id: 1, effort: 5 }, /effort control/u],
] as const)
  test(`a worker without ${option} cannot receive speculative mutations`, async t => {
    const worker = fixture(t, { [option]: false })
    const result = await invokeManagerTodo(
      worker.pi,
      worker.ctx,
      request,
      undefined,
      worker.runtime,
    )

    assert.equal(result.isError, true)
    assert.deepEqual(result.details, { outcome: "unavailable" })
    const first = result.content[0]
    assert.ok(first)
    assert.match(first.text, message)
    assert.deepEqual(
      worker.state.processPriorities(
        () => assert.fail("No revision may be read"),
        () => assert.fail("No priority mutation may execute"),
        () => assert.fail("No task mutation may execute"),
      ),
      Either.right([]),
    )
  })
