import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import type { TodoRequest } from "../todo/state.ts"
import {
  startManagerTaskServer,
  type ManagerTaskServer,
} from "./manager-task-rpc.ts"
import {
  managerPairDirectory,
  ManagerSessionError,
} from "./manager-session-core.ts"
import { prepareNativeManagerState } from "./manager-native-state.ts"
import { invokeManagerTodo } from "./manager-client.ts"
import { registerManagerBinding } from "../shared/manager-binding.ts"

const fixture = (
  t: test.TestContext,
  available = true,
  mode: "paired" | "global" = "paired",
  priorityAvailable = false,
) => {
  const root = mkdtempSync("/tmp/pmc-")
  let server: ManagerTaskServer | undefined
  t.after(async () => {
    if (server) await Effect.runPromise(server.close)
    rmSync(root, { recursive: true })
  })
  const scope = { workerSessionId: "worker", cwd: "/projects/worker" }
  const directory = managerPairDirectory({
    workerSessionId: scope.workerSessionId,
    workerCwd: scope.cwd,
    agentDir: root,
  })
  assert.ok(Either.isRight(directory))
  const state = prepareNativeManagerState(directory.right, scope)
  assert.ok(Either.isRight(state))
  state.right.publish({
    ...scope,
    version: 1,
    observedAt: Date.now(),
    priorityRevision: "revision-1",
    data: {
      todoControl: available,
      ...(priorityAvailable ? { todoPriorityControl: true } : {}),
    },
  })
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
    cwd: mode === "global" ? "/global/manager" : scope.cwd,
    sessionManager: {
      getSessionId: () => "manager-session",
      getBranch: () => [],
    },
  } as unknown as ExtensionContext
  registerManagerBinding(pi, id =>
    id === "manager-session"
      ? {
          role: "manager",
          workerSessionId: "worker",
          ...(mode === "global" ? { workerCwd: scope.cwd } : {}),
        }
      : undefined,
  )
  const start = async (
    apply: (request: TodoRequest) => Either.Either<string, ManagerSessionError>,
  ) => {
    const authority = state.right.taskAuthority
    assert.ok(authority)
    server = await Effect.runPromise(
      startManagerTaskServer({
        directory: directory.right,
        authority,
        revision: () => Either.right("revision-1"),
        invoke: operation =>
          operation.kind === "todo"
            ? apply(operation.request)
            : assert.fail("Wrong control lane"),
      }),
    )
  }
  return { pi, ctx, state: state.right, root, start }
}

test("retired manager enqueue APIs fail closed and never consume historical task files", t => {
  const f = fixture(t)
  assert.ok(
    Either.isLeft(f.state.enqueueTodo({ action: "list" }, "revision-1")),
  )
  assert.ok(Either.isLeft(f.state.enqueuePriorities("1", "revision-1")))
  const directory = managerPairDirectory({
    agentDir: f.root,
    workerSessionId: "worker",
    workerCwd: "/projects/worker",
  })
  assert.ok(Either.isRight(directory))
  const legacy = join(
    directory.right,
    "requests",
    "00000000-0000-4000-8000-000000000055.json",
  )
  writeFileSync(legacy, JSON.stringify({ version: 2, operation: "todo" }), {
    mode: 0o600,
  })
  assert.deepEqual(
    f.state.processPriorities(
      () => "revision-1",
      () => assert.fail("Retired priority command executed"),
      () => assert.fail("Retired task command executed"),
    ),
    Either.right([]),
  )
  assert.equal(
    existsSync(legacy),
    true,
    "historical files remain inert, not consumed or migrated",
  )
})

test("manager todo returns the verified worker result rather than a manager-local task snapshot", async t => {
  const f = fixture(t)
  let calls = 0
  await f.start(request => {
    assert.deepEqual(request, { action: "add", text: "Real worker task" })
    calls += 1
    return Either.right("Added worker task #5")
  })
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "add", text: "Real worker task" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () =>
        assert.fail("Direct calls must never poll a deferred task command"),
    },
  )
  assert.equal(result.isError, false)
  assert.equal(result.details.outcome, "completed")
  assert.match(result.content[0]?.text ?? "", /Added worker task #5/u)
  assert.equal(Object.hasOwn(result.details, "state"), false)
  assert.equal(calls, 1)
})

test("global manager todo uses the selected worker project rather than the manager workspace", async t => {
  const f = fixture(t, true, "global")
  await f.start(() => Either.right("Actual selected worker backlog"))
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "list" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("No polling"),
    },
  )
  assert.equal(result.details.outcome, "completed")
  assert.match(result.content[0]?.text ?? "", /Actual selected worker backlog/u)
})

test("an indeterminate worker result stays unconfirmed instead of becoming a failed or completed write", async t => {
  const f = fixture(t)
  await f.start(() =>
    Either.left(
      new ManagerSessionError({
        code: "unconfirmed",
        message: "Persistence result is unconfirmed; inspect before retry.",
      }),
    ),
  )
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "add", text: "Uncertain" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("No polling"),
    },
  )
  assert.equal(result.details.outcome, "unconfirmed")
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /worker/u)
  assert.match(result.content[0]!.text, /\/projects\/worker/u)
})

test("an older worker without the task-control capability does not receive a speculative mutation", async t => {
  const f = fixture(t, false)
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "clear" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("No polling"),
    },
  )
  assert.equal(result.details.outcome, "unavailable")
  assert.deepEqual(
    f.state.processPriorities(
      () => "revision-1",
      () => assert.fail("Unexpected priority request"),
      () => assert.fail("Unsupported task request was queued"),
    ),
    Either.right([]),
  )
})

test("an older todo-capable worker cannot receive a speculative priority mutation", async t => {
  const f = fixture(t, true, "global")
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "priority", id: 1, priority: 2 },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("No polling"),
    },
  )
  assert.equal(result.details.outcome, "unavailable")
  assert.deepEqual(
    f.state.processPriorities(
      () => "revision-1",
      () => assert.fail("wrong lane"),
      () => assert.fail("priority was queued to an older worker"),
    ),
    Either.right([]),
  )
})

test("unsupported effort reports the exact selected worker before dispatch", async t => {
  const f = fixture(t, true, "global", true)
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "effort", id: 55, effort: 5 },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("No polling"),
    },
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.text, /\/projects\/worker/u)
  assert.match(result.content[0]!.text, /session worker/u)
  assert.match(result.content[0]!.text, /effort control/u)
  assert.deepEqual(
    f.state.processPriorities(
      () => "revision-1",
      () => assert.fail("Unexpected priority request"),
      () => assert.fail("Unsupported effort must not queue"),
    ),
    Either.right([]),
  )
})

test("global priority correction crosses the direct todo lane and returns the worker result", async t => {
  const f = fixture(t, true, "global", true)
  let calls = 0
  await f.start(request => {
    calls += 1
    assert.deepEqual(request, { action: "priority", id: 1, priority: 2 })
    return Either.right("Todo #1 priority 2")
  })
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "priority", id: 1, priority: 2 },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("No polling"),
    },
  )
  assert.equal(result.details.outcome, "completed")
  assert.match(result.content[0]?.text ?? "", /Todo #1 priority 2/u)
  assert.equal(calls, 1)
})

test("an absent direct worker returns an error and leaves no deferred task command", async t => {
  const f = fixture(t)
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "add", text: "Pending" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => assert.fail("No polling"),
    },
  )
  assert.equal(result.isError, true)
  assert.notEqual(result.details.outcome, "queued")
  assert.deepEqual(
    f.state.processPriorities(
      () => "revision-1",
      () => assert.fail("Unexpected priorities"),
      () => assert.fail("No task command may execute after the failed call"),
    ),
    Either.right([]),
  )
})
