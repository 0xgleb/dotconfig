import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

  const requestsDirectory = join(directory.right, "requests")
  writeFileSync(
    join(requestsDirectory, "00000000-0000-4000-8000-000000000058.json"),
    JSON.stringify({ version: 2, operation: "todo", historical: true }),
    { mode: 0o600 },
  )

  const requestFiles = () =>
    readdirSync(requestsDirectory)
      .toSorted()
      .map(name => ({
        name,
        content: readFileSync(join(requestsDirectory, name), "utf8"),
      }))

  const handlers = new Map<string, ((value: unknown) => void)[]>()
  const pi = {
    getFlag: () => undefined,
    events: {
      on: (name: string, handler: (value: unknown) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])

        return () => {
          handlers.set(
            name,
            (handlers.get(name) ?? []).filter(listener => listener !== handler),
          )
        }
      },
      emit: (name: string, value: unknown) => {
        for (const handler of handlers.get(name) ?? []) handler(value)
      },
    },
  } satisfies Pick<ExtensionAPI, "getFlag" | "events">
  const sessionManager = {
    getSessionId: () => "manager-session",
    getBranch: () => [],
  } satisfies Pick<
    ExtensionContext["sessionManager"],
    "getSessionId" | "getBranch"
  >

  // These clients use only the checked binding and session surfaces.
  const partialHost: Partial<ExtensionAPI> = pi
  const host = partialHost as ExtensionAPI
  const partialSession: Partial<ExtensionContext["sessionManager"]> =
    sessionManager
  const context = {
    cwd: options.managerCwd ?? scope.cwd,
    sessionManager: partialSession as ExtensionContext["sessionManager"],
  } satisfies Partial<ExtensionContext>
  const ctx = context as ExtensionContext

  registerManagerBinding(host, id =>
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

  return { pi: host, ctx, state: state.right, runtime, requestFiles }
}

for (const managerCwd of ["/projects/worker", "/global/manager"])
  test(`manager task calls fail closed for the selected worker from ${managerCwd}`, async t => {
    const worker = fixture(t, { managerCwd })
    const before = worker.requestFiles()

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
      assert.deepEqual(worker.requestFiles(), before)

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
    const before = worker.requestFiles()

    const result = await invokeManagerTodo(
      worker.pi,
      worker.ctx,
      request,
      undefined,
      worker.runtime,
    )

    assert.equal(result.isError, true)
    assert.deepEqual(result.details, { outcome: "unavailable" })
    assert.deepEqual(worker.requestFiles(), before)

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
