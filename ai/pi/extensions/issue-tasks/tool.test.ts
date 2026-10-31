import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import test, { mock } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Deferred, Effect, Either, Option, Schema } from "effect"
import {
  openSqliteTaskStore,
  TaskCommitUnknownError,
  type SqliteTaskStore,
  type SqliteTaskStoreOptions,
} from "./sqlite-store.ts"
import { MutationBatchIdSchema } from "./model.ts"
import { decodeIssueReference } from "./identity.ts"
import type { IssueTaskTool, TaskToolOptions } from "./tool.ts"

const piExecutable = realpathSync(
  execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
)
const hostRoot = join(
  dirname(dirname(piExecutable)),
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
const tools: typeof import("./tool.ts") = await loader.import(
  fileURLToPath(new URL("./tool.ts", import.meta.url)),
)
const { validateToolArguments } = await import(
  pathToFileURL(
    join(
      hostRoot,
      "node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
    ),
  ).href
)

const rawIssue = { repository: "0xgleb/dotconfig", number: 1 }
const fixtureParent = fileURLToPath(
  new URL("../../../../.tmp/issue-plans-tests/", import.meta.url),
)
const fixture = async (
  work: (store: SqliteTaskStore) => Promise<void>,
  options: Omit<SqliteTaskStoreOptions, "databasePath"> = {},
) => {
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(fixtureParent, "tool-"))
  try {
    const store = await Effect.runPromise(
      openSqliteTaskStore({
        ...options,
        databasePath: join(root, "tasks.sqlite"),
      }),
    )
    try {
      await work(store)
    } finally {
      await Effect.runPromise(store.close())
    }
  } finally {
    rmSync(root, { recursive: true })
  }
}
const nativeContext = {
  sessionManager: { getSessionId: () => "fixture-reader" },
} as unknown as Parameters<IssueTaskTool["execute"]>[4]
const register = (options: TaskToolOptions): IssueTaskTool => {
  const captured: unknown[] = []
  const tool = tools.registerTaskTool(
    {
      registerTool: (definition: unknown) => {
        captured.push(definition)
      },
    },
    options,
  )
  assert.deepEqual(captured, [tool])
  assert.equal(tool.name, "task")
  return tool
}
const invoke = (
  tool: IssueTaskTool,
  args: unknown,
  id = "fixture-call",
  signal?: AbortSignal,
) => {
  const validated = validateToolArguments(tool, {
    type: "toolCall",
    id,
    name: "task",
    arguments: args,
  })
  return tool.execute(id, validated, signal, undefined, nativeContext)
}

const issue = () => {
  const decoded = decodeIssueReference(rawIssue)
  assert.ok(Either.isRight(decoded))
  return decoded.right
}
const ordinaryOptions = (store: SqliteTaskStore): TaskToolOptions => ({
  store,
  contextForCall: call =>
    Effect.succeed({
      actorId: call.sessionId,
      requestId: call.toolCallId,
      now: 1_000,
      cancellation: "forbidden",
    }),
  renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
})
const addRequest = {
  action: "apply",
  issues: [rawIssue],
  operations: [{ op: "add", issue: rawIssue, key: "one", text: "Requirement" }],
}

test("registered task apply uses host identity, replays one native request and supports qualified get", async () =>
  fixture(async store => {
    const options = ordinaryOptions(store)
    const nativeCalls: unknown[] = []
    const tool = register({
      ...options,
      contextForCall: call => {
        nativeCalls.push(call)
        return options.contextForCall(call)
      },
    })

    const first = await invoke(tool, addRequest, "write-call")
    const replay = await invoke(tool, addRequest, "write-call")

    assert.equal(first.details.outcome.kind, "saved")
    assert.equal(replay.details.outcome.kind, "saved")
    if (
      first.details.outcome.kind !== "saved" ||
      replay.details.outcome.kind !== "saved"
    )
      assert.fail("Expected saved receipts")
    assert.equal(first.details.outcome.result.receipt, "committed")
    assert.equal(replay.details.outcome.result.receipt, "replayed")
    assert.deepEqual(
      first.details.outcome.result.created,
      replay.details.outcome.result.created,
    )
    assert.deepEqual(nativeCalls, [
      { toolCallId: "write-call", sessionId: "fixture-reader" },
      { toolCallId: "write-call", sessionId: "fixture-reader" },
    ])
    const created = first.details.outcome.result.created[0]
    assert.ok(created)

    const found = await invoke(tool, {
      action: "get",
      issue: rawIssue,
      id: created.id,
    })

    assert.equal(found.details.outcome.kind, "task")
    if (found.details.outcome.kind !== "task")
      assert.fail("Expected task detail")
    assert.equal(found.details.outcome.detail.task.id, created.id)
    assert.deepEqual(found.details.outcome.detail.dependsOn, [])
    assert.equal(
      nativeCalls.length,
      2,
      "Read-only get must not request mutation authority",
    )
  }))

for (const field of [
  "actorId",
  "requestId",
  "now",
  "cancellation",
  "authority",
  "expectedRevisions",
  "worker",
  "planId",
  "reply",
]) {
  test(`actual SDK rejects caller authority or legacy metadata: ${field}`, async () =>
    fixture(async store => {
      let hostCalls = 0
      const options = ordinaryOptions(store)
      const tool = register({
        ...options,
        contextForCall: call => {
          hostCalls += 1
          return options.contextForCall(call)
        },
      })

      assert.throws(() => invoke(tool, { ...addRequest, [field]: "forged" }))
      assert.equal(hostCalls, 0)
      assert.ok(
        Option.isNone(
          await Effect.runPromise(store.readTasks(issue(), { limit: 1 })),
        ),
      )
    }))
}

test("registered task validates per-action fields before host context or store effects", async () =>
  fixture(async store => {
    let hostCalls = 0
    const options = ordinaryOptions(store)
    const tool = register({
      ...options,
      contextForCall: call => {
        hostCalls += 1
        return options.contextForCall(call)
      },
    })

    for (const request of [
      { action: "read", issue: rawIssue },
      {
        action: "read",
        issue: rawIssue,
        page: { limit: 1 },
        operations: addRequest.operations,
      },
      {
        ...addRequest,
        operations: [
          {
            op: "edit",
            target: {
              issue: rawIssue,
              task: {
                kind: "existing",
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              },
            },
          },
        ],
      },
    ]) {
      const result = await invoke(tool, request)
      assert.equal(result.isError, true)
      assert.equal(result.details.outcome.kind, "failed")
    }
    assert.equal(hostCalls, 0)
    assert.ok(
      Option.isNone(
        await Effect.runPromise(store.readTasks(issue(), { limit: 1 })),
      ),
    )
  }))

test("registered task distinguishes ordinary worker operations from explicit privileged status grants", async () =>
  fixture(async store => {
    const options = ordinaryOptions(store)
    const ordinary = register(options)
    const created = await invoke(ordinary, addRequest, "add-before-cancel")
    assert.equal(created.details.outcome.kind, "saved")
    if (created.details.outcome.kind !== "saved")
      assert.fail("Expected saved addition")
    const task = created.details.outcome.result.created[0]
    assert.ok(task)
    const statusRequest = (status: string) => ({
      action: "apply",
      issues: [rawIssue],
      operations: [
        {
          op: "status",
          target: { issue: rawIssue, task: { kind: "existing", id: task.id } },
          status,
        },
      ],
    })

    const denied = await invoke(
      ordinary,
      statusRequest("cancelled"),
      "deny-cancel",
    )

    assert.equal(denied.details.outcome.kind, "failed")
    if (denied.details.outcome.kind !== "failed")
      assert.fail("Expected denied transition")
    assert.equal(denied.details.outcome.code, "unauthorized")
    const granted = register({
      ...options,
      contextForCall: call =>
        options.contextForCall(call).pipe(
          Effect.map(context => ({
            ...context,
            cancellation: "owner-authorized" as const,
          })),
        ),
    })

    const cancelled = await invoke(
      granted,
      statusRequest("cancelled"),
      "allow-cancel",
    )
    const deniedReopen = await invoke(
      ordinary,
      statusRequest("todo"),
      "deny-reopen",
    )
    const reopened = await invoke(
      granted,
      statusRequest("todo"),
      "allow-reopen",
    )

    assert.equal(cancelled.details.outcome.kind, "saved")
    assert.equal(deniedReopen.details.outcome.kind, "failed")
    assert.equal(reopened.details.outcome.kind, "saved")
  }))

test("post-commit renderer failure preserves saved outcome and same-request replay", async () =>
  fixture(async store => {
    const tool = register({
      ...ordinaryOptions(store),
      renderOutput: () =>
        Effect.fail(
          new tools.TaskOutputError({
            message: "Private rendering diagnostic",
          }),
        ),
    })

    const first = await invoke(tool, addRequest, "render-failed")
    const replay = await invoke(tool, addRequest, "render-failed")

    assert.notEqual(
      first.isError,
      true,
      "A committed write must not become a failed write",
    )
    assert.equal(first.details.outcome.kind, "saved")
    assert.equal(replay.details.outcome.kind, "saved")
    if (
      first.details.outcome.kind !== "saved" ||
      replay.details.outcome.kind !== "saved"
    )
      assert.fail("Expected durable receipts")
    assert.equal(first.details.output, "unavailable")
    assert.equal(replay.details.outcome.result.receipt, "replayed")
    const text = first.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
    assert.ok(text.includes(first.details.outcome.result.batchId))
    assert.ok(!text.includes("Private rendering diagnostic"))
    const page = await Effect.runPromise(
      store.readTasks(issue(), { limit: 100 }),
    )
    assert.ok(Option.isSome(page))
    assert.equal(page.value.tasks.length, 1)
  }))

for (const output of ["x".repeat(50 * 1_024 + 1), "x\n".repeat(2_001)]) {
  test(`oversized renderer output keeps saved truth and bounded content: ${output.length}`, async () =>
    fixture(async store => {
      const tool = register({
        ...ordinaryOptions(store),
        renderOutput: () => Effect.succeed(output),
      })
      const result = await invoke(tool, addRequest)

      assert.equal(result.details.outcome.kind, "saved")
      assert.equal(result.details.output, "unavailable")
      const text = result.content
        .filter(part => part.type === "text")
        .map(part => part.text)
        .join("\n")
      assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1_024)
      assert.ok(text.split("\n").length <= 2_000)
    }))
}

test("pre-aborted task execution performs no host resolution or task write", async () =>
  fixture(async store => {
    let hostCalls = 0
    const options = ordinaryOptions(store)
    const tool = register({
      ...options,
      contextForCall: call => {
        hostCalls += 1
        return options.contextForCall(call)
      },
    })
    const controller = new AbortController()
    controller.abort()

    const result = await invoke(
      tool,
      addRequest,
      "pre-aborted",
      controller.signal,
    )

    assert.equal(result.details.outcome.kind, "interrupted")
    assert.equal(hostCalls, 0)
    assert.ok(
      Option.isNone(
        await Effect.runPromise(store.readTasks(issue(), { limit: 1 })),
      ),
    )
  }))

test(
  "SDK signal interruption during a real write rolls back without cancelling task status",
  { timeout: 5_000 },
  async t => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const controller = new AbortController()
    t.signal.addEventListener("abort", () => controller.abort(), { once: true })
    await fixture(
      async store => {
        const tool = register(ordinaryOptions(store))
        const pending = invoke(
          tool,
          addRequest,
          "interrupt-write",
          controller.signal,
        )
        const entered = await Promise.race([
          Effect.runPromise(Deferred.await(started)).then(() => true),
          pending.then(() => false),
        ])
        assert.equal(
          entered,
          true,
          "Executor returned before entering the real transaction",
        )
        controller.abort()

        const result = await pending

        assert.equal(result.details.outcome.kind, "unconfirmed")
        if (result.details.outcome.kind !== "unconfirmed")
          assert.fail("Expected explicit unconfirmed write")
        assert.equal(result.details.outcome.stop, "interrupted")
        assert.deepEqual(result.details.outcome.invocation, {
          toolCallId: "interrupt-write",
          sessionId: "fixture-reader",
        })
        assert.notEqual(result.isError, true)
        assert.ok(
          Option.isNone(
            await Effect.runPromise(store.readTasks(issue(), { limit: 1 })),
          ),
        )
      },
      {
        taskTransactionBeginSignal: Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
      },
    )
  },
)

test("signal abort at successful COMMIT preserves unconfirmed invocation and durable replay", async () =>
  fixture(async store => {
    const tool = register(ordinaryOptions(store))
    const controller = new AbortController()
    const exec = DatabaseSync.prototype.exec
    const interception = mock.method(
      DatabaseSync.prototype,
      "exec",
      function (this: DatabaseSync, query: string) {
        const result = Reflect.apply(exec, this, [query])
        if (query === "COMMIT") controller.abort()
        return result
      },
    )
    try {
      const result = await invoke(
        tool,
        addRequest,
        "commit-abort",
        controller.signal,
      )
      assert.equal(result.details.outcome.kind, "unconfirmed")
      if (result.details.outcome.kind !== "unconfirmed")
        assert.fail("Expected explicit unconfirmed write")
      assert.equal(result.details.outcome.stop, "interrupted")
      assert.deepEqual(result.details.outcome.invocation, {
        toolCallId: "commit-abort",
        sessionId: "fixture-reader",
      })
      assert.notEqual(result.isError, true)
    } finally {
      interception.mock.restore()
    }

    const replay = await invoke(tool, addRequest, "commit-abort")

    assert.equal(replay.details.outcome.kind, "saved")
    if (replay.details.outcome.kind !== "saved")
      assert.fail("Expected durable original receipt")
    assert.equal(replay.details.outcome.result.receipt, "replayed")
    const page = await Effect.runPromise(store.readTasks(issue(), { limit: 1 }))
    assert.ok(Option.isSome(page))
    assert.equal(page.value.tasks.length, 1)
  }))

test("typed unknown completion is projected without raw cause or automatic retry", async () =>
  fixture(async store => {
    const batchId = Schema.decodeUnknownSync(MutationBatchIdSchema)(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )
    let calls = 0
    const port: SqliteTaskStore = {
      ...store,
      apply: () => {
        calls += 1
        return Effect.fail(
          new TaskCommitUnknownError({
            code: "unknown_completion",
            batchId,
            requestId: "uncertain-call",
            message: "Verify the original request before retrying",
            cause: { private: "Do not expose this diagnostic" },
          }),
        )
      },
    }
    const tool = register(ordinaryOptions(port))

    const result = await invoke(tool, addRequest, "uncertain-call")

    assert.equal(result.details.outcome.kind, "unknown")
    assert.equal(calls, 1)
    const text = result.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n")
    assert.ok(!text.includes("Do not expose this diagnostic"))
    assert.ok(
      !JSON.stringify(result.details).includes("Do not expose this diagnostic"),
    )
  }))

test("host unavailability is a typed failure without task writes", async () =>
  fixture(async store => {
    const tool = register({
      ...ordinaryOptions(store),
      contextForCall: () =>
        Effect.fail(
          new tools.TaskHostError({
            code: "host_unavailable",
            message: "Host context unavailable",
          }),
        ),
    })

    const result = await invoke(tool, addRequest)

    assert.equal(result.details.outcome.kind, "failed")
    if (result.details.outcome.kind !== "failed")
      assert.fail("Expected host failure")
    assert.equal(result.details.outcome.code, "host_unavailable")
    assert.ok(
      Option.isNone(
        await Effect.runPromise(store.readTasks(issue(), { limit: 1 })),
      ),
    )
  }))

test("registered read and get report missing issue state without creating it", async () =>
  fixture(async store => {
    const tool = register(ordinaryOptions(store))

    for (const request of [
      { action: "read", issue: rawIssue, page: { limit: 1 } },
      {
        action: "get",
        issue: rawIssue,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ]) {
      const result = await invoke(tool, request)
      assert.equal(
        result.details.outcome.kind,
        request.action === "read" ? "missing_issue" : "missing_task",
      )
      assert.notEqual(result.isError, true)
    }
    assert.ok(
      Option.isNone(
        await Effect.runPromise(store.readTasks(issue(), { limit: 1 })),
      ),
    )
  }))

for (const output of ["🦆".repeat(12_800), "x\n".repeat(1_999)]) {
  test(`renderer admits exact byte or line budget: ${output.length}`, async () =>
    fixture(async store => {
      const tool = register({
        ...ordinaryOptions(store),
        renderOutput: () => Effect.succeed(output),
      })

      const result = await invoke(tool, addRequest)

      assert.equal(result.details.outcome.kind, "saved")
      assert.equal(result.details.output, "complete")
      assert.deepEqual(result.content, [{ type: "text", text: output }])
    }))
}

for (const stage of ["host", "store"] as const) {
  test(`unexpected ${stage} defect preserves whether a write was entered`, async () =>
    fixture(async store => {
      const port: SqliteTaskStore =
        stage === "store"
          ? { ...store, apply: () => Effect.die("Private defect detail") }
          : store
      const options = ordinaryOptions(port)
      const tool = register({
        ...options,
        contextForCall:
          stage === "host"
            ? () => Effect.die("Private defect detail")
            : options.contextForCall,
      })

      const result = await invoke(tool, addRequest, "defect-call")

      if (stage === "host") {
        assert.equal(result.details.outcome.kind, "failed")
        if (result.details.outcome.kind !== "failed")
          assert.fail("Expected pre-write failure")
        assert.equal(result.details.outcome.code, "execution_defect")
      } else {
        assert.equal(result.details.outcome.kind, "unconfirmed")
        if (result.details.outcome.kind !== "unconfirmed")
          assert.fail("Expected unconfirmed write")
        assert.equal(result.details.outcome.stop, "execution_defect")
        assert.deepEqual(result.details.outcome.invocation, {
          toolCallId: "defect-call",
          sessionId: "fixture-reader",
        })
      }
      assert.equal(result.isError, true)
      assert.ok(!JSON.stringify(result).includes("Private defect detail"))
    }))
}

test("qualified get misses retain the requested task even when the issue exists", async () =>
  fixture(async store => {
    const options = ordinaryOptions(store)
    const tool = register({
      ...options,
      renderOutput: () =>
        Effect.fail(new tools.TaskOutputError({ message: "Unavailable" })),
    })
    const seeded = await invoke(tool, addRequest, "existing-issue")
    assert.equal(seeded.details.outcome.kind, "saved")
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    const result = await invoke(tool, { action: "get", issue: rawIssue, id })

    assert.deepEqual(result.details.outcome, {
      kind: "missing_task",
      target: { issue: issue(), id },
    })
    const text = result.content
      .filter((part: { type: string }) => part.type === "text")
      .map((part: { type: string; text?: string }) => part.text ?? "")
      .join("\n")
    assert.ok(text.includes(id))
    assert.ok(!text.includes("No task state found"))
    assert.ok(
      Option.isSome(
        await Effect.runPromise(store.readTasks(issue(), { limit: 1 })),
      ),
    )
  }))

test("actual SDK exposes and validates operation and qualified-reference shapes", async () =>
  fixture(async store => {
    const tool = register(ordinaryOptions(store))
    const target = {
      issue: rawIssue,
      task: { kind: "existing", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    }

    for (const operation of [
      { op: "add", issue: rawIssue, key: "one" },
      { op: "edit", target, authority: "owner" },
      { op: "status", target, status: "in_review" },
      { op: "block", target },
      { op: "transfer", target },
      { op: "edit", target: { task: target.task }, text: "Changed" },
    ])
      assert.throws(() =>
        invoke(tool, { ...addRequest, operations: [operation] }),
      )
  }))

test("actual SDK executes all documented mutation shapes including creation references", async () =>
  fixture(async store => {
    const tool = register(ordinaryOptions(store))
    const destination = { repository: "other/repo", number: 1 }
    const target = { issue: rawIssue, task: { kind: "added", key: "one" } }

    const result = await invoke(tool, {
      action: "apply",
      issues: [rawIssue, destination],
      operations: [
        ...addRequest.operations,
        { op: "edit", target, text: "Edited" },
        { op: "block", target, reason: "Blocked" },
        { op: "transfer", target, toIssue: destination },
        { op: "status", target, status: "doing" },
      ],
    })

    assert.equal(result.details.outcome.kind, "saved")
    if (result.details.outcome.kind !== "saved")
      assert.fail("Expected saved batch")
    const created = result.details.outcome.result.created[0]
    assert.ok(created)
    const found = await invoke(tool, {
      action: "get",
      issue: destination,
      id: created.id,
    })

    assert.equal(found.details.outcome.kind, "task")
    if (found.details.outcome.kind !== "task")
      assert.fail("Expected transferred task")
    assert.equal(found.details.outcome.detail.task.text, "Edited")
    assert.equal(found.details.outcome.detail.task.blocker, "Blocked")
    assert.equal(found.details.outcome.detail.task.status, "doing")
  }))

for (const failure of ["defect", "interrupt"] as const) {
  test(
    `post-save renderer ${failure} cannot erase the saved receipt`,
    { timeout: 5_000 },
    async t =>
      fixture(async store => {
        const controller = new AbortController()
        t.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        })
        const options = ordinaryOptions(store)
        const tool = register({
          ...options,
          renderOutput:
            failure === "defect"
              ? () => Effect.die("Private renderer defect")
              : () =>
                  Effect.sync(() => controller.abort()).pipe(
                    Effect.zipRight(Effect.never),
                  ),
        })

        const result = await invoke(
          tool,
          addRequest,
          "render-stop",
          controller.signal,
        )

        assert.equal(result.details.outcome.kind, "saved")
        assert.equal(result.details.output, "unavailable")
        assert.notEqual(result.isError, true)
        assert.ok(!JSON.stringify(result).includes("Private renderer defect"))
        const replay = await invoke(
          register(options),
          addRequest,
          "render-stop",
        )
        assert.equal(replay.details.outcome.kind, "saved")
        if (replay.details.outcome.kind !== "saved")
          assert.fail("Expected saved replay")
        assert.equal(replay.details.outcome.result.receipt, "replayed")
      }),
  )
}

test("actual SDK validates and executes an unwired registered issue task read offline", async () =>
  fixture(async store => {
    const saved = await Effect.runPromise(
      store.apply(
        {
          issues: [rawIssue],
          operations: [
            { op: "add", issue: rawIssue, key: "one", text: "Requirement" },
          ],
        },
        {
          actorId: "fixture",
          requestId: "seed",
          now: 1_000,
          cancellation: "forbidden",
        },
      ),
    )
    let hostCalls = 0
    const tool = register({
      store,
      contextForCall: () => {
        hostCalls += 1
        return Effect.fail(
          new tools.TaskHostError({
            code: "host_unavailable",
            message: "No mutation grant",
          }),
        )
      },
      renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
    })

    const result = await invoke(tool, {
      action: "read",
      issue: rawIssue,
      page: { limit: 1 },
    })

    assert.notEqual(result.isError, true)
    assert.equal(result.details.outcome.kind, "page")
    if (result.details.outcome.kind !== "page")
      assert.fail("Expected task page")
    assert.equal(result.details.outcome.page.tasks[0]?.id, saved.created[0]?.id)
    assert.equal(
      hostCalls,
      0,
      "Reads must not depend on mutation authority or a manager",
    )
  }))
