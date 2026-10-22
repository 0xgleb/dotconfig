import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
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
) => {
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
  state.right.publish({
    ...scope,
    version: 1,
    observedAt: Date.now(),
    priorityRevision: "revision-1",
    data: { todoControl: available },
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
  return { pi, ctx, state: state.right, root }
}

test("manager todo returns the verified worker result rather than a manager-local task snapshot", async t => {
  const f = fixture(t)
  let calls = 0
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "add", text: "Real worker task" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => {
        const processed = f.state.processPriorities(
          () => "revision-1",
          () => assert.fail("Wrong control lane"),
          request => {
            assert.deepEqual(request, {
              action: "add",
              text: "Real worker task",
            })
            calls += 1
            return Either.right("Added worker task #5")
          },
        )
        assert.ok(Either.isRight(processed))
      },
    },
  )
  assert.equal(result.isError, false)
  assert.equal(result.details.outcome, "completed")
  assert.equal(result.content[0]?.text, "Added worker task #5")
  assert.equal(Object.hasOwn(result.details, "state"), false)
  assert.equal(calls, 1)
})

test("global manager todo uses the selected worker project rather than the manager workspace", async t => {
  const f = fixture(t, true, "global")
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "list" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => {
        f.state.processPriorities(
          () => "revision-1",
          () => assert.fail("Wrong lane"),
          () => Either.right("Actual selected worker backlog"),
        )
      },
    },
  )
  assert.equal(result.details.outcome, "completed")
  assert.equal(result.content[0]?.text, "Actual selected worker backlog")
})

test("an indeterminate worker result stays unconfirmed instead of becoming a failed or completed write", async t => {
  const f = fixture(t)
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "add", text: "Uncertain" },
    undefined,
    {
      agentDir: f.root,
      timeoutMs: 1000,
      wait: async () => {
        f.state.processPriorities(
          () => "revision-1",
          () => assert.fail("Wrong lane"),
          () =>
            Either.left(
              new ManagerSessionError({
                code: "unconfirmed",
                message:
                  "Persistence result is unconfirmed; inspect before retry.",
              }),
            ),
        )
      },
    },
  )
  assert.equal(result.details.outcome, "unconfirmed")
  assert.equal(result.isError, true)
})

test("an older worker without the task-control capability does not receive a speculative mutation", async t => {
  const f = fixture(t, false)
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "clear" },
    undefined,
    { agentDir: f.root, timeoutMs: 0, wait: async () => {} },
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

test("a queued but unsettled task mutation is not reported as completed", async t => {
  const f = fixture(t)
  const result = await invokeManagerTodo(
    f.pi,
    f.ctx,
    { action: "add", text: "Pending" },
    undefined,
    { agentDir: f.root, timeoutMs: 0, wait: async () => {} },
  )
  assert.equal(result.details.outcome, "queued")
  assert.match(result.content[0]?.text ?? "", /not confirmed/u)
})
