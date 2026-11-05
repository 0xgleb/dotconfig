import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import test, { mock } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Cause, Deferred, Effect, Either, Exit, Scope } from "effect"
import type { NativeTaskToolOptions } from "./native.ts"
import type { IssueTaskTool } from "./tool.ts"
import type { TaskStoreError } from "./sqlite-store.ts"

const executable = realpathSync(
  execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
)
const hostRoot = join(
  dirname(dirname(executable)),
  "lib/node_modules/pi-monorepo",
)
const host = createRequire(join(hostRoot, "package.json"))

const { createJiti } = await import(
  pathToFileURL(join(hostRoot, "dist/core/extensions/jiti-loader.js")).href
)
const loader = createJiti(import.meta.url, {
  alias: { typebox: host.resolve("typebox") },
  moduleCache: false,
  fsCache: false,
})

const native: typeof import("./native.ts") = await loader.import(
  fileURLToPath(new URL("./native.ts", import.meta.url)),
)

const { validateToolArguments } = await import(
  pathToFileURL(
    join(
      hostRoot,
      "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
    ),
  ).href
)

const fixtureParent = fileURLToPath(
  new URL("../../../../.tmp/issue-task-native-tests/", import.meta.url),
)
const fixture = async (work: (root: string) => Promise<void>) => {
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(fixtureParent, "native-"))

  try {
    await work(root)
  } finally {
    rmSync(root, { recursive: true })
  }
}

const issue = { repository: "0xgleb/dotconfig", number: 1 }
const add = {
  action: "apply",
  issues: [issue],
  operations: [{ op: "add", issue, key: "one", text: "Requirement" }],
}
const read = { action: "read", issue, page: { limit: 10 } }
// Only getSessionId is consumed; other SDK capabilities are intentionally absent.
const context = {
  sessionManager: { getSessionId: () => "native-fixture" },
} as unknown as Parameters<IssueTaskTool["execute"]>[4]

const invoke = (
  tool: IssueTaskTool,
  request: unknown,
  id = "fixture-call",
  signal?: AbortSignal,
) =>
  tool.execute(
    id,
    validateToolArguments(tool, {
      type: "toolCall",
      id,
      name: "task",
      arguments: request,
    }),
    signal,
    undefined,
    context,
  )

const options = (root: string): NativeTaskToolOptions => ({
  databasePath: join(root, "tasks.sqlite"),
  cwd: root,
  contextForCall: call =>
    Effect.succeed({
      actorId: call.sessionId,
      requestId: call.toolCallId,
      now: 1000,
      cancellation: "forbidden",
    }),
  renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
  onCloseFailure: error =>
    Effect.sync(() => assert.fail(`Unexpected close failure: ${error.code}`)),
})

const acquire = (scope: Scope.CloseableScope, input: NativeTaskToolOptions) =>
  Effect.runPromise(Scope.extend(native.acquireNativeTaskTool(input), scope))
const close = (scope: Scope.CloseableScope) =>
  Effect.runPromise(Scope.close(scope, Exit.void))

test("native composition executes SDK-validated local actions and closes with its scope", () =>
  fixture(async root => {
    const scope = Effect.runSync(Scope.make())
    let grants = 0
    const input = options(root)

    try {
      const tool = await acquire(scope, {
        ...input,
        contextForCall: call => {
          grants += 1

          return input.contextForCall(call)
        },
      })

      assert.equal((await invoke(tool, add)).details.outcome.kind, "saved")

      const result = await invoke(tool, read)

      assert.equal(result.details.outcome.kind, "page")
      if (result.details.outcome.kind === "page")
        assert.equal(result.details.outcome.page.tasks.length, 1)
      assert.equal(grants, 1)

      await close(scope)

      const stopped = (await invoke(tool, read)).details.outcome

      assert.equal(stopped.kind, "failed")
      if (stopped.kind === "failed") assert.equal(stopped.code, "closed")

      await close(scope)
    } finally {
      await close(scope)
    }
  }))

test("independent native scopes share persisted tasks but not connection lifetime", () =>
  fixture(async root => {
    const first = Effect.runSync(Scope.make())
    const second = Effect.runSync(Scope.make())

    try {
      const writer = await acquire(first, options(root))
      const reader = await acquire(second, options(root))

      assert.equal((await invoke(writer, add)).details.outcome.kind, "saved")

      await close(first)

      const result = (await invoke(reader, read)).details.outcome

      assert.equal(result.kind, "page")
      if (result.kind === "page") assert.equal(result.page.tasks.length, 1)
    } finally {
      await close(first)
      await close(second)
    }
  }))

test("pre-aborted native acquisition creates no database", () =>
  fixture(async root => {
    const controller = new AbortController()
    controller.abort()

    const result = await Effect.runPromiseExit(
      Effect.scoped(native.acquireNativeTaskTool(options(root))),
      { signal: controller.signal },
    )

    assert.ok(Exit.isFailure(result))
    assert.equal(Cause.isInterruptedOnly(result.cause), true)
    assert.equal(existsSync(join(root, "tasks.sqlite")), false)
  }))

test("native acquisition preserves typed store initialization failure", () =>
  fixture(async root => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          native.acquireNativeTaskTool({
            ...options(root),
            databasePath: "relative.sqlite",
          }),
        ),
      ),
    )

    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_path")
  }))

test("native opening captures the host file and callbacks before deferred execution", () =>
  fixture(async root => {
    const scope = Effect.runSync(Scope.make())
    const original = options(root)
    let originalGrants = 0
    let originalRenders = 0

    const input = {
      ...original,
      contextForCall: (
        call: Parameters<NativeTaskToolOptions["contextForCall"]>[0],
      ) => {
        originalGrants += 1

        return original.contextForCall(call)
      },
      renderOutput: (
        outcome: Parameters<NativeTaskToolOptions["renderOutput"]>[0],
      ) => {
        originalRenders += 1

        return Effect.succeed(`Original ${outcome.kind}`)
      },
    }

    const pending = native.acquireNativeTaskTool(input)

    input.databasePath = join(root, "redirected.sqlite")
    input.contextForCall = () => Effect.die("Redirected authority was used")
    input.renderOutput = () => Effect.succeed("Redirected output")

    try {
      const tool = await Effect.runPromise(Scope.extend(pending, scope))

      const saved = await invoke(tool, add)

      assert.equal(saved.details.outcome.kind, "saved")
      assert.deepEqual(saved.content, [
        { type: "text", text: "Original saved" },
      ])
      assert.equal(originalGrants, 1)
      assert.equal(originalRenders, 1)
      assert.equal(existsSync(join(root, "tasks.sqlite")), true)
      assert.equal(existsSync(join(root, "redirected.sqlite")), false)
    } finally {
      await close(scope)
    }
  }))

test("failed native GitHub transport does not disable local task operations", () =>
  fixture(async root => {
    const scope = Effect.runSync(Scope.make())

    try {
      const tool = await acquire(scope, {
        ...options(root),
        cwd: join(root, "missing"),
      })

      const remote = (
        await invoke(tool, {
          action: "getIssue",
          query: {
            issue,
            related: { limit: 1 },
            tasks: { page: { limit: 1 } },
          },
        })
      ).details.outcome

      assert.equal(remote.kind, "failed")
      if (remote.kind === "failed") assert.equal(remote.code, "transport_error")

      assert.equal((await invoke(tool, add)).details.outcome.kind, "saved")
      assert.equal((await invoke(tool, read)).details.outcome.kind, "page")
    } finally {
      await close(scope)
    }
  }))

test("interruption between native acquisition and consumer handoff closes the acquired store", () =>
  fixture(async root => {
    const acquired = Effect.runSync(Deferred.make<IssueTaskTool>())
    const controller = new AbortController()
    const running = Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const tool = yield* native.acquireNativeTaskTool(options(root))
          yield* Deferred.succeed(acquired, tool)
          yield* Effect.never
        }),
      ),
      { signal: controller.signal },
    )

    try {
      const tool = await Effect.runPromise(
        Deferred.await(acquired).pipe(Effect.timeout("2 seconds")),
      )

      controller.abort()

      const result = await running

      assert.ok(Exit.isFailure(result))
      assert.equal(Cause.isInterruptedOnly(result.cause), true)

      const stopped = (await invoke(tool, read)).details.outcome

      assert.equal(stopped.kind, "failed")
      if (stopped.kind === "failed") assert.equal(stopped.code, "closed")
    } finally {
      controller.abort()
      await running
    }
  }))

test("typed close failures reach the host reporter without changing the earlier saved result", () =>
  fixture(async root => {
    const scope = Effect.runSync(Scope.make())
    const failures: TaskStoreError[] = []
    const input = {
      ...options(root),
      onCloseFailure: (error: TaskStoreError) =>
        Effect.sync(() => {
          failures.push(error)
        }),
    }
    const pending = native.acquireNativeTaskTool(input)

    input.onCloseFailure = () =>
      Effect.sync(() => assert.fail("Redirected close reporter was used"))

    try {
      const tool = await Effect.runPromise(Scope.extend(pending, scope))

      const saved = await invoke(tool, add)

      assert.equal(saved.details.outcome.kind, "saved")

      const originalClose = DatabaseSync.prototype.close
      const patched = mock.method(
        DatabaseSync.prototype,
        "close",
        function (this: DatabaseSync) {
          originalClose.call(this)
          throw new Error("Fixture close acknowledgement failure")
        },
      )

      try {
        await close(scope)
      } finally {
        patched.mock.restore()
      }

      assert.equal(failures.length, 1)
      assert.equal(failures[0]?.code, "io")
      assert.equal(saved.details.outcome.kind, "saved")

      await close(scope)

      assert.equal(failures.length, 1)
    } finally {
      await close(scope)
    }
  }))

// The same source-owned, non-secret opt-in used by github-cli.live.test.ts.
const liveReadEnabled = process.env.PI_ISSUE_TASK_GITHUB_LIVE_READ_TESTS === "1"

test(
  "native composition joins real GitHub detail with isolated local tasks",
  { skip: !liveReadEnabled, timeout: 45_000 },
  async t =>
    fixture(async root => {
      const scope = Effect.runSync(Scope.make())
      const liveIssue = { repository: "0xgleb/dotconfig", number: 86 }

      try {
        const tool = await acquire(scope, {
          ...options(root),
          renderOutput: () => Effect.succeed("Native fixture read"),
        })
        const seeded = await invoke(
          tool,
          {
            action: "apply",
            issues: [liveIssue],
            operations: [
              { op: "add", issue: liveIssue, key: "one", text: "Fixture" },
            ],
          },
          "seed-local",
          t.signal,
        )

        assert.equal(seeded.details.outcome.kind, "saved")

        const result = await invoke(
          tool,
          {
            action: "getIssue",
            query: {
              issue: liveIssue,
              related: { limit: 1 },
              tasks: { page: { limit: 1 } },
            },
          },
          "read-live",
          t.signal,
        )
        const outcome = result.details.outcome

        assert.equal(outcome.kind, "issue_detail")
        if (outcome.kind !== "issue_detail") return

        assert.equal(outcome.view.issue.repository, liveIssue.repository)
        assert.equal(outcome.view.issue.number, liveIssue.number)
        assert.equal(outcome.view.detail !== null, true)
        assert.equal(typeof outcome.view.detail?.body, "string")
        assert.equal(outcome.view.tasks?.tasks.length, 1)
        assert.equal(result.details.output, "complete")
      } finally {
        await close(scope)
      }
    }),
)
