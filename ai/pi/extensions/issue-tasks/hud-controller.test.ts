import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import test, { after, mock } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Deferred, Effect, Exit, Option, Scope } from "effect"
import { setImmediate } from "node:timers/promises"
import { openSqliteTaskStore, type SqliteTaskStore } from "./sqlite-store.ts"
import { nativeNextResult } from "./test-fixtures/next-result.ts"
import type { NativeTaskHostOptions } from "./host.ts"
import type { TaskHudOptions } from "./hud-controller.ts"

const executable = realpathSync(
  execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
)
const hostRoot = join(
  dirname(dirname(executable)),
  "lib/node_modules/pi-monorepo",
)
const previousFsCache = process.env.JITI_FS_CACHE
process.env.JITI_FS_CACHE = "false"
after(() => {
  if (previousFsCache === undefined) delete process.env.JITI_FS_CACHE
  else process.env.JITI_FS_CACHE = previousFsCache
})
const sdk = await import(
  pathToFileURL(join(hostRoot, "dist/bundle/index.js")).href
)
const parent = fileURLToPath(
  new URL("../../../../.tmp/task-hud/", import.meta.url),
)

const assistant = (id: string, args: unknown) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "task", arguments: args }],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 1000,
})

const resultMessage = (id: string, details: unknown) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "task",
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
  isError: false,
  timestamp: 1001,
})

const fixture = async (
  work: (value: {
    readonly runner: InstanceType<typeof sdk.ExtensionRunner>
    readonly session: InstanceType<typeof sdk.SessionManager>
    readonly store: SqliteTaskStore
    readonly bridge: {
      register: (options: NativeTaskHostOptions) => void
      registerWithObserverFailure: (options: NativeTaskHostOptions) => void
      acquire: (
        options: Omit<TaskHudOptions, "pi">,
      ) => ReturnType<typeof import("./hud-controller.ts").acquireTaskHud>
    }
    readonly databasePath: string
    readonly frame: () => string
    readonly statuses: Map<string, string>
    readonly widgets: Map<string, { render: (width: number) => string[] }>
    readonly waitStatus: (expected: string | undefined) => Promise<void>
  }) => Promise<void>,
) => {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "controller-"))
  const databasePath = join(root, "tasks.sqlite")
  const store = await Effect.runPromise(openSqliteTaskStore({ databasePath }))
  const eventBus = sdk.createEventBus()
  const captured: unknown[] = []
  const stop = eventBus.on("issue-task-hud-test-host", (value: unknown) =>
    captured.push(value),
  )
  let runner: InstanceType<typeof sdk.ExtensionRunner> | undefined
  try {
    const loaded = await sdk.discoverAndLoadExtensions(
      [fileURLToPath(new URL("./test-fixtures/hud-host.ts", import.meta.url))],
      root,
      root,
      eventBus,
    )
    assert.deepEqual(loaded.errors, [])
    assert.equal(captured.length, 1)
    const bridge = captured[0] as Parameters<typeof work>[0]["bridge"]
    const session = sdk.SessionManager.inMemory(root)
    const active = new sdk.ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      root,
      session,
      {},
    )
    runner = active
    sdk.initTheme("dark")
    const baseUi = active.getUIContext()
    const statuses = new Map<string, string>()
    const widgets = new Map<string, { render: (width: number) => string[] }>()
    const waiters: { expected: string | undefined; resolve: () => void }[] = []
    active.setUIContext(
      {
        ...baseUi,
        setStatus: (key: string, text: string | undefined) => {
          if (text === undefined) statuses.delete(key)
          else statuses.set(key, text)
          for (const waiter of [...waiters]) {
            if (text !== waiter.expected) continue
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve()
          }
        },
        setWidget: (
          key: string,
          factory: unknown,
          options?: { placement?: string },
        ) => {
          if (factory === undefined) {
            widgets.delete(key)
            return
          }
          assert.equal(options?.placement, "aboveEditor")
          assert.equal(typeof factory, "function")
          if (typeof factory === "function")
            widgets.set(key, factory({ requestRender: () => {} }, baseUi.theme))
        },
      },
      "tui",
    )
    await work({
      runner: active,
      session,
      store,
      databasePath,
      bridge,
      statuses,
      widgets,
      frame: () =>
        [...widgets.values()].flatMap(widget => widget.render(120)).join("\n"),
      waitStatus: expected =>
        [...statuses.values()].includes(expected ?? "") ||
        (expected === undefined && statuses.size === 0)
          ? Promise.resolve()
          : new Promise(resolve => waiters.push({ expected, resolve })),
    })
  } finally {
    stop()
    if (runner !== undefined)
      await runner.emit({ type: "session_shutdown", reason: "quit" })
    await Effect.runPromise(store.close())
    rmSync(root, { recursive: true })
  }
}

const seed = async (
  store: Parameters<Parameters<typeof fixture>[0]>[0]["store"],
  issue: unknown,
  text: string,
) => {
  await Effect.runPromise(
    store.apply(
      {
        issues: [issue],
        operations: [
          { op: "add", issue, key: "current", text },
          {
            op: "status",
            target: { issue, task: { kind: "added", key: "current" } },
            status: "doing",
          },
        ],
      },
      {
        actorId: "hud-fixture",
        requestId: text,
        now: 1000,
        cancellation: "forbidden",
      },
    ),
  )
}

test(
  "ordinary local task results refresh counts without selecting their referenced issue",
  { timeout: 5000 },
  async () =>
    fixture(
      async ({
        runner,
        session,
        store,
        bridge,
        databasePath,
        frame,
        waitStatus,
      }) => {
        const selected = await nativeNextResult()
        const other = await nativeNextResult(8)
        session.appendMessage(assistant("fixture-next-7", selected.args))
        session.appendMessage(resultMessage("fixture-next-7", selected.details))
        await seed(store, selected.issue, "Current issue requirement")
        await seed(store, other.issue, "Unrelated issue requirement")
        bridge.register({ databasePath, onOpenFailure: () => Effect.void })
        await runner.emit({ type: "session_start", reason: "startup" })
        await waitStatus("tasks:0/1 settled")
        const tasks = await Effect.runPromise(
          store.readTasks(selected.issue, { limit: 1 }),
        )
        assert.ok(Option.isSome(tasks))
        const current = tasks.value.tasks[0]
        assert.ok(current)
        await Effect.runPromise(
          store.apply(
            {
              issues: [selected.issue],
              operations: [
                {
                  op: "status",
                  target: {
                    issue: selected.issue,
                    task: { kind: "existing", id: current.id },
                  },
                  status: "done",
                },
              ],
            },
            {
              actorId: "fixture",
              requestId: "complete-current",
              now: 2000,
              cancellation: "forbidden",
            },
          ),
        )
        const args = { action: "read", issue: other.issue, page: { limit: 1 } }
        const call = assistant("incidental-read", args)
        await runner.emitMessageEnd({ type: "message_end", message: call })
        session.appendMessage(call)
        const tool = runner.getToolDefinition("task")
        assert.ok(tool)
        const result = await tool.execute(
          "incidental-read",
          args,
          undefined,
          undefined,
          runner.createToolContext("incidental-read", undefined),
        )
        const message = resultMessage("incidental-read", result.details)
        await runner.emitMessageEnd({ type: "message_end", message })
        session.appendMessage(message)
        await waitStatus("tasks:1/1 settled")
        assert.match(frame(), /owner\/repo#7/)
        assert.match(frame(), /All tasks settled/)
        assert.doesNotMatch(frame(), /Unrelated issue requirement/)
      },
    ),
)

test(
  "session tree restores native issue focus and empty work unmounts both native surfaces",
  { timeout: 5000 },
  async () =>
    fixture(
      async ({
        runner,
        session,
        store,
        bridge,
        databasePath,
        frame,
        waitStatus,
        statuses,
        widgets,
      }) => {
        const before = session.appendMessage({
          role: "user",
          content: [{ type: "text", text: "Fixture start" }],
          timestamp: 0,
        })
        const first = await nativeNextResult()
        const second = await nativeNextResult(8)
        await seed(store, first.issue, "First branch requirement")
        await seed(store, second.issue, "Second branch requirement")
        session.appendMessage(assistant("fixture-next-7", first.args))
        const firstLeaf = session.appendMessage(
          resultMessage("fixture-next-7", first.details),
        )
        session.appendMessage(assistant("fixture-next-8", second.args))
        const secondLeaf = session.appendMessage(
          resultMessage("fixture-next-8", second.details),
        )
        bridge.register({ databasePath, onOpenFailure: () => Effect.void })
        await runner.emit({ type: "session_start", reason: "startup" })
        await waitStatus("tasks:0/1 settled")
        assert.match(frame(), /Second branch requirement/)
        session.branch(firstLeaf)
        await runner.emit({
          type: "session_tree",
          oldLeafId: secondLeaf,
          newLeafId: firstLeaf,
        })
        await waitStatus("tasks:0/1 settled")
        assert.match(frame(), /First branch requirement/)
        assert.doesNotMatch(frame(), /Second branch requirement/)
        session.branch(before)
        await runner.emit({
          type: "session_tree",
          oldLeafId: firstLeaf,
          newLeafId: before,
        })
        assert.equal(widgets.size, 0)
        assert.equal(statuses.size, 0)
      },
    ),
)

test(
  "late ignored-abort reads cannot repaint a newer native selection",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, session, store, bridge, frame, waitStatus }) => {
      const first = await nativeNextResult()
      const second = await nativeNextResult(8)
      await seed(store, first.issue, "Stale requirement")
      await seed(store, second.issue, "New current requirement")
      session.appendMessage(assistant("fixture-next-7", first.args))
      session.appendMessage(resultMessage("fixture-next-7", first.details))
      const scope = Effect.runSync(Scope.make())
      const gate = Effect.runSync(Deferred.make<void>())
      const started = Effect.runSync(Deferred.make<void>())
      const finished = Effect.runSync(Deferred.make<void>())
      const failures: unknown[] = []
      try {
        await Effect.runPromise(
          Scope.extend(
            bridge.acquire({
              ctx: runner.createContext(),
              readProgress: issue =>
                issue.number === 7
                  ? Effect.uninterruptible(
                      Effect.gen(function* () {
                        yield* Deferred.succeed(started, undefined)
                        yield* Deferred.await(gate)
                        return yield* store.readProgress(issue)
                      }),
                    ).pipe(
                      Effect.ensuring(Deferred.succeed(finished, undefined)),
                    )
                  : store.readProgress(issue),
              isCurrent: () => true,
              claimPresentation: () => {},
              ownsPresentation: () => true,
              onFailure: error =>
                Effect.sync(() => {
                  failures.push(error)
                }),
            }),
            scope,
          ),
        )
        await Effect.runPromise(Deferred.await(started))
        for (const message of [
          assistant("fixture-next-8", second.args),
          resultMessage("fixture-next-8", second.details),
        ]) {
          await runner.emitMessageEnd({ type: "message_end", message })
          session.appendMessage(message)
        }
        await waitStatus("tasks:0/1 settled")
        assert.match(frame(), /New current requirement/)
        await Effect.runPromise(Deferred.succeed(gate, undefined))
        await Effect.runPromise(Deferred.await(finished))
        await setImmediate()
        assert.match(frame(), /New current requirement/)
        assert.doesNotMatch(frame(), /Stale requirement/)
        assert.deepEqual(failures, [])
      } finally {
        await Effect.runPromise(Deferred.succeed(gate, undefined))
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
      assert.equal(runner.hasHandlers("message_end"), false)
      assert.equal(runner.hasHandlers("turn_end"), false)
      assert.equal(runner.hasHandlers("session_tree"), false)
    }),
)

test(
  "missing mixed-version progress capability and closed stores remain unavailable rather than zero",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, session, store, bridge, frame, statuses }) => {
      const selected = await nativeNextResult()
      session.appendMessage(assistant("fixture-next-7", selected.args))
      session.appendMessage(resultMessage("fixture-next-7", selected.details))
      await Effect.runPromise(store.close())
      for (const readProgress of [undefined, store.readProgress]) {
        const scope = Effect.runSync(Scope.make())
        try {
          await Effect.runPromise(
            Scope.extend(
              bridge.acquire({
                ctx: runner.createContext(),
                readProgress,
                isCurrent: () => true,
                claimPresentation: () => {},
                ownsPresentation: () => true,
                onFailure: () => Effect.void,
              }),
              scope,
            ),
          )
          await setImmediate()
          assert.ok([...statuses.values()].includes("tasks:unavailable"))
          assert.match(frame(), /Progress unavailable/)
          assert.doesNotMatch(frame(), /0\/0|100%/)
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void))
        }
      }
    }),
)

test(
  "scope close removes UI and waits for an ignored-abort read without late repaint",
  { timeout: 5000 },
  async () =>
    fixture(
      async ({
        runner,
        session,
        store,
        bridge,
        waitStatus,
        widgets,
        statuses,
      }) => {
        const selected = await nativeNextResult()
        await seed(store, selected.issue, "Closing requirement")
        session.appendMessage(assistant("fixture-next-7", selected.args))
        session.appendMessage(resultMessage("fixture-next-7", selected.details))
        const scope = Effect.runSync(Scope.make())
        const started = Effect.runSync(Deferred.make<void>())
        const gate = Effect.runSync(Deferred.make<void>())
        let finished = false
        let closing: Promise<void> | undefined
        try {
          await Effect.runPromise(
            Scope.extend(
              bridge.acquire({
                ctx: runner.createContext(),
                readProgress: issue =>
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(started, undefined)
                      yield* Deferred.await(gate)
                      return yield* store.readProgress(issue)
                    }),
                  ),
                isCurrent: () => true,
                claimPresentation: () => {},
                ownsPresentation: () => true,
                onFailure: () => Effect.void,
              }),
              scope,
            ),
          )
          await Effect.runPromise(Deferred.await(started))
          closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(
            () => {
              finished = true
            },
          )
          await waitStatus(undefined)
          assert.equal(widgets.size, 0)
          assert.equal(finished, false)
          await Effect.runPromise(Deferred.succeed(gate, undefined))
          await closing
          assert.equal(widgets.size, 0)
          assert.equal(statuses.size, 0)
          assert.equal(runner.hasHandlers("message_end"), false)
        } finally {
          await Effect.runPromise(Deferred.succeed(gate, undefined))
          await (closing ?? Effect.runPromise(Scope.close(scope, Exit.void)))
        }
      },
    ),
)

test(
  "an older scope cannot clear presentation claimed by the new native lifetime",
  { timeout: 5000 },
  async () =>
    fixture(
      async ({
        runner,
        session,
        store,
        bridge,
        frame,
        waitStatus,
        widgets,
      }) => {
        const first = await nativeNextResult()
        const second = await nativeNextResult(8)
        await seed(store, first.issue, "Older scope requirement")
        await seed(store, second.issue, "New owner requirement")
        session.appendMessage(assistant("fixture-next-7", first.args))
        session.appendMessage(resultMessage("fixture-next-7", first.details))
        const oldScope = Effect.runSync(Scope.make())
        const newScope = Effect.runSync(Scope.make())
        const oldToken = Symbol("old")
        const newToken = Symbol("new")
        let current = oldToken
        let owner: symbol | undefined
        const started = Effect.runSync(Deferred.make<void>())
        const gate = Effect.runSync(Deferred.make<void>())
        const ownership = (token: symbol) => ({
          isCurrent: () => current === token,
          claimPresentation: () => {
            owner = token
          },
          ownsPresentation: () => owner === token,
        })
        try {
          await Effect.runPromise(
            Scope.extend(
              bridge.acquire({
                ctx: runner.createContext(),
                readProgress: issue =>
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(started, undefined)
                      yield* Deferred.await(gate)
                      return yield* store.readProgress(issue)
                    }),
                  ),
                ...ownership(oldToken),
                onFailure: () => Effect.void,
              }),
              oldScope,
            ),
          )
          await Effect.runPromise(Deferred.await(started))
          current = newToken
          session.appendMessage(assistant("fixture-next-8", second.args))
          session.appendMessage(resultMessage("fixture-next-8", second.details))
          await Effect.runPromise(
            Scope.extend(
              bridge.acquire({
                ctx: runner.createContext(),
                readProgress: store.readProgress,
                ...ownership(newToken),
                onFailure: () => Effect.void,
              }),
              newScope,
            ),
          )
          await waitStatus("tasks:0/1 settled")
          assert.match(frame(), /New owner requirement/)
          const closing = Effect.runPromise(Scope.close(oldScope, Exit.void))
          await Effect.runPromise(Deferred.succeed(gate, undefined))
          await closing
          assert.equal(widgets.size, 1)
          assert.match(frame(), /New owner requirement/)
        } finally {
          await Effect.runPromise(Deferred.succeed(gate, undefined))
          await Effect.runPromise(Scope.close(oldScope, Exit.void))
          await Effect.runPromise(Scope.close(newScope, Exit.void))
        }
      },
    ),
)

test(
  "cross-issue progress fails visibly without projecting another qualified issue",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, session, store, bridge, frame, waitStatus }) => {
      const selected = await nativeNextResult()
      const other = await nativeNextResult(8)
      await seed(store, other.issue, "Wrong issue requirement")
      session.appendMessage(assistant("fixture-next-7", selected.args))
      session.appendMessage(resultMessage("fixture-next-7", selected.details))
      const scope = Effect.runSync(Scope.make())
      const failures: string[] = []
      try {
        await Effect.runPromise(
          Scope.extend(
            bridge.acquire({
              ctx: runner.createContext(),
              readProgress: () => store.readProgress(other.issue),
              isCurrent: () => true,
              claimPresentation: () => {},
              ownsPresentation: () => true,
              onFailure: error =>
                Effect.sync(() => {
                  failures.push(error.code)
                }),
            }),
            scope,
          ),
        )
        await waitStatus("tasks:unavailable")
        await setImmediate()
        assert.match(frame(), /owner\/repo#7/)
        assert.doesNotMatch(frame(), /Wrong issue requirement/)
        assert.deepEqual(failures, ["invalid_progress"])
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
    }),
)

test(
  "HUD animation follows actual SDK idleness rather than persisted doing tasks",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, session, store, bridge, frame, waitStatus }) => {
      const selected = await nativeNextResult()
      await seed(store, selected.issue, "Still persisted as doing")
      await Effect.runPromise(
        store.apply(
          {
            issues: [selected.issue],
            operations: [
              {
                op: "add",
                issue: selected.issue,
                key: "settled",
                text: "Settled requirement",
              },
              {
                op: "status",
                target: {
                  issue: selected.issue,
                  task: { kind: "added", key: "settled" },
                },
                status: "done",
              },
            ],
          },
          {
            actorId: "hud-fixture",
            requestId: "animation-state",
            now: 1000,
            cancellation: "forbidden",
          },
        ),
      )
      session.appendMessage(assistant("idle-next", selected.args))
      session.appendMessage(resultMessage("idle-next", selected.details))
      const scope = Effect.runSync(Scope.make())
      const clock = mock.method(Date, "now", () => 0)
      let idle = true
      const ctx = runner.createContext()
      const activity = mock.method(ctx, "isIdle", () => idle)
      try {
        await Effect.runPromise(
          Scope.extend(
            bridge.acquire({
              ctx,
              readProgress: store.readProgress,
              isCurrent: () => true,
              claimPresentation: () => {},
              ownsPresentation: () => true,
              onFailure: () => Effect.void,
            }),
            scope,
          ),
        )
        await waitStatus("tasks:1/2 settled")
        assert.doesNotMatch(frame(), /▰/u)
        idle = false
        assert.match(frame(), /▰/u)
        assert.match(frame(), /1\/2 settled/)
        assert.match(frame(), /Still persisted as doing/)
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
        clock.mock.restore()
        activity.mock.restore()
      }
    }),
)

test(
  "non-UI SDK contexts acquire no widgets or observer resources",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, bridge, store, widgets, statuses }) => {
      runner.setUIContext(undefined)
      const scope = Effect.runSync(Scope.make())
      try {
        await Effect.runPromise(
          Scope.extend(
            bridge.acquire({
              ctx: runner.createContext(),
              readProgress: store.readProgress,
              isCurrent: () => true,
              claimPresentation: () =>
                assert.fail("No UI presentation may be claimed"),
              ownsPresentation: () => false,
              onFailure: () => Effect.void,
            }),
            scope,
          ),
        )
        assert.equal(widgets.size, 0)
        assert.equal(statuses.size, 0)
        assert.equal(runner.hasHandlers("message_end"), false)
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
    }),
)

test(
  "a HUD reporter defect cannot undo native task registration",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, bridge, databasePath }) => {
      const errors: unknown[] = []
      runner.onError((error: unknown) => errors.push(error))
      bridge.registerWithObserverFailure({
        databasePath,
        onHudFailure: () =>
          Effect.die(new Error("SDK warning transport failed")),
        onOpenFailure: () => Effect.void,
      })
      await runner.emit({ type: "session_start", reason: "startup" })
      const tool = runner.getToolDefinition("task")
      assert.ok(
        tool,
        "Optional presentation reporting cannot disable task operations",
      )
      assert.equal(errors.length, 1)
      assert.match(JSON.stringify(errors), /SDK warning transport failed/)
      const result = await tool.execute(
        "read-after-reporter-failure",
        {
          action: "read",
          issue: { repository: "owner/repo", number: 7 },
          page: { limit: 1 },
        },
        undefined,
        undefined,
        runner.createContext(),
      )
      assert.equal(result.isError, false)
      assert.equal(result.details.outcome.kind, "missing_issue")
    }),
)

test(
  "HUD degradation uses its specific optional channel rather than core initialization failure",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, bridge, databasePath }) => {
      const hudFailures: unknown[] = []
      const coreFailures: unknown[] = []
      bridge.registerWithObserverFailure({
        databasePath,
        onHudFailure: error =>
          Effect.sync(() => {
            hudFailures.push(error.code)
          }),
        onOpenFailure: error =>
          Effect.sync(() => {
            coreFailures.push(error)
          }),
      })
      await runner.emit({ type: "session_start", reason: "startup" })
      assert.ok(runner.getToolDefinition("task"))
      assert.deepEqual(hudFailures, ["subscription_unavailable"])
      assert.deepEqual(coreFailures, [])
    }),
)

test(
  "optional HUD observer failure releases partial subscriptions without disabling native task operations",
  { timeout: 5000 },
  async () =>
    fixture(async ({ runner, bridge, databasePath, statuses, widgets }) => {
      const failures: unknown[] = []
      bridge.registerWithObserverFailure({
        databasePath,
        onOpenFailure: error =>
          Effect.sync(() => {
            failures.push(error)
          }),
      })
      await runner.emit({ type: "session_start", reason: "startup" })
      const tool = runner.getToolDefinition("task")
      assert.ok(
        tool,
        "A presentation failure must not disable the native task tool",
      )
      const selected = await nativeNextResult()
      const read = await tool.execute(
        "read-after-ui-failure",
        { action: "read", issue: selected.issue, page: { limit: 1 } },
        undefined,
        undefined,
        runner.createToolContext("read-after-ui-failure", undefined),
      )
      assert.equal(read.details.outcome.kind, "missing_issue")
      assert.equal(runner.hasHandlers("message_end"), false)
      assert.equal(widgets.size, 0)
      assert.equal(statuses.size, 0)
      assert.equal(failures.length, 1)
    }),
)

test(
  "actual SDK host restores selected-issue HUD from SQLite and tears it down with the store",
  { timeout: 10000 },
  async () =>
    fixture(
      async ({
        runner,
        session,
        store,
        bridge,
        databasePath,
        frame,
        waitStatus,
        widgets,
        statuses,
      }) => {
        const selected = await nativeNextResult()
        const id = "fixture-next-7"
        session.appendMessage(assistant(id, selected.args))
        session.appendMessage(resultMessage(id, selected.details))
        await seed(store, selected.issue, "Persisted current HUD task")
        const failures: unknown[] = []
        bridge.register({
          databasePath,
          onOpenFailure: error =>
            Effect.sync(() => {
              failures.push(error)
            }),
        })
        await runner.emit({ type: "session_start", reason: "startup" })
        const tool = runner.getToolDefinition("task")
        assert.ok(tool)
        assert.equal(typeof tool.readProgress, "function")
        await waitStatus("tasks:0/1 settled")
        assert.match(frame(), /owner\/repo#7/)
        assert.match(frame(), /Persisted current HUD task/)
        assert.equal(widgets.size, 1)
        await runner.emit({ type: "session_shutdown", reason: "quit" })
        assert.equal(widgets.size, 0)
        assert.equal(statuses.size, 0)
        assert.deepEqual(failures, [])
      },
    ),
)

test(
  "SDK HUD observer handles message_end before persistence and pending native selection clears progress",
  { timeout: 10000 },
  async () =>
    fixture(
      async ({
        runner,
        session,
        store,
        bridge,
        frame,
        waitStatus,
        statuses,
        widgets,
      }) => {
        const scope = Effect.runSync(Scope.make())
        const selected = await nativeNextResult()
        await seed(store, selected.issue, "Live current HUD task")
        const failures: unknown[] = []
        try {
          await Effect.runPromise(
            Scope.extend(
              bridge.acquire({
                ctx: runner.createContext(),
                readProgress: store.readProgress,
                isCurrent: () => true,
                claimPresentation: () => {},
                ownsPresentation: () => true,
                onFailure: error =>
                  Effect.sync(() => {
                    failures.push(error)
                  }),
              }),
              scope,
            ),
          )
          assert.equal(widgets.size, 0)
          const call = assistant("fixture-next-7", selected.args)
          await runner.emitMessageEnd({ type: "message_end", message: call })
          assert.ok([...statuses.values()].includes("tasks:unconfirmed"))
          session.appendMessage(call)
          const result = resultMessage("fixture-next-7", selected.details)
          await runner.emitMessageEnd({ type: "message_end", message: result })
          session.appendMessage(result)
          await waitStatus("tasks:0/1 settled")
          assert.match(frame(), /Live current HUD task/)
          assert.match(frame(), /owner\/repo#7/)
          const next = assistant("next-pending", selected.args)
          await runner.emitMessageEnd({ type: "message_end", message: next })
          assert.ok([...statuses.values()].includes("tasks:unconfirmed"))
          assert.doesNotMatch(frame(), /Live current HUD task/)
          assert.deepEqual(failures, [])
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void))
        }
      },
    ),
)
