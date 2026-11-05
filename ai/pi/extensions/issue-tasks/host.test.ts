import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { registerNativeTaskHost, type NativeTaskHostOptions } from "./host.ts"
import type { IssueTaskTool, TaskHostError } from "./tool.ts"
import { TaskStoreError } from "./sqlite-store.ts"

const parent = fileURLToPath(
  new URL("../../../../.tmp/issue-task-host-tests/", import.meta.url),
)
const issue = { repository: "owner/repository", number: 1 }
const add = {
  action: "apply",
  issues: [issue],
  operations: [{ op: "add", issue, key: "one", text: "Requirement" }],
}
const read = { action: "read", issue, page: { limit: 10 } }

type Handler = (event: unknown, context: unknown) => unknown
const fixture = async (work: (root: string) => Promise<void>) => {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "host-"))

  try {
    await work(root)
  } finally {
    rmSync(root, { recursive: true })
  }
}

const host = (root: string, patch: Partial<NativeTaskHostOptions> = {}) => {
  const handlers = new Map<string, Handler>()
  const tools: IssueTaskTool[] = []
  const attempted: IssueTaskTool[] = []
  let registrationFailure = false
  const opened: (TaskStoreError | TaskHostError)[] = []
  const closed: TaskStoreError[] = []
  let now = 1000
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    registerTool: (tool: IssueTaskTool) => {
      attempted.push(tool)
      if (registrationFailure) throw new Error("Private registration fault")
      tools.push(tool)
    },
  } as unknown as Pick<ExtensionAPI, "on" | "registerTool">
  const context = {
    cwd: root,
    sessionManager: { getSessionId: () => "host-session" },
  } as unknown as Parameters<IssueTaskTool["execute"]>[4]

  registerNativeTaskHost(pi, {
    databasePath: join(root, "tasks.sqlite"),
    contextForCall: call =>
      Effect.succeed({
        actorId: call.sessionId,
        requestId: call.toolCallId,
        now,
        cancellation: "forbidden",
      }),
    renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
    onOpenFailure: error =>
      Effect.sync(() => {
        opened.push(error)
      }),
    onCloseFailure: error =>
      Effect.sync(() => {
        closed.push(error)
      }),
    ...patch,
  })

  const emit = async (name: string) => {
    const handler = handlers.get(name)

    assert.ok(handler, `Missing ${name} handler`)
    await handler({ type: name }, context)
  }

  const tool = () => {
    const value = tools.at(-1)

    assert.ok(value)
    return value
  }

  const invoke = (request: unknown, id = "host-call", signal?: AbortSignal) =>
    tool().execute(
      id,
      request as Parameters<IssueTaskTool["execute"]>[1],
      signal,
      undefined,
      context,
    )

  const cleanup = async () => {
    const handler = handlers.get("session_shutdown")

    if (handler !== undefined)
      await handler({ type: "session_shutdown" }, context)
  }

  return {
    emit,
    tool,
    tools,
    attempted,
    rejectRegistration: () => {
      registrationFailure = true
    },
    invoke,
    cleanup,
    opened,
    closed,
    context,
    advance: () => {
      now += 1
    },
  }
}

test("native task host registers after session start and releases its actual store at shutdown", () =>
  fixture(async root => {
    const f = host(root)

    try {
      assert.equal(f.tools.length, 0)
      await f.emit("session_start")
      assert.equal(f.tool().name, "task")
      assert.equal((await f.invoke(add)).details.outcome.kind, "saved")
      const page = (await f.invoke(read)).details.outcome

      assert.ok(page.kind === "page")
      assert.equal(page.page.tasks.length, 1)
      await f.emit("session_shutdown")
      const stopped = (await f.invoke(read)).details.outcome

      assert.ok(stopped.kind === "failed")
      assert.equal(stopped.code, "closed")
      await f.emit("session_shutdown")
      assert.deepEqual(f.opened, [])
      assert.deepEqual(f.closed, [])
    } finally {
      await f.cleanup()
    }
  }))

test("native task host preserves SDK invocation identity through shutdown and reload", () =>
  fixture(async root => {
    const f = host(root)

    try {
      await f.emit("session_start")
      const initial = (await f.invoke(add, "same-sdk-call")).details.outcome

      assert.ok(initial.kind === "saved")
      assert.equal(initial.result.receipt, "committed")
      await f.emit("session_shutdown")
      f.advance()
      await f.emit("session_start")
      const replay = (await f.invoke(add, "same-sdk-call")).details.outcome

      assert.ok(replay.kind === "saved")
      assert.equal(replay.result.receipt, "replayed")
      assert.deepEqual(replay.result.created, initial.result.created)
      const page = (await f.invoke(read)).details.outcome

      assert.ok(page.kind === "page")
      assert.equal(page.page.tasks.length, 1)
    } finally {
      await f.cleanup()
    }
  }))

test("native task host closes its acquired store when SDK registration fails", () =>
  fixture(async root => {
    const f = host(root)
    f.rejectRegistration()

    try {
      await f.emit("session_start")
      assert.equal(f.tools.length, 0)
      assert.equal(f.opened.length, 1)
      const error = f.opened[0]

      assert.ok(error?._tag === "TaskHostError")
      assert.equal(error.code, "host_unavailable")
      assert.equal(error.message, "Task tool registration did not complete")
      assert.ok(!JSON.stringify(error).includes("Private registration fault"))
      const attempted = f.attempted[0]

      assert.ok(attempted)
      const outcome = (
        await attempted.execute(
          "read-after-failure",
          read,
          undefined,
          undefined,
          f.context,
        )
      ).details.outcome

      assert.ok(outcome.kind === "failed")
      assert.equal(outcome.code, "closed")
    } finally {
      await f.cleanup()
    }
  }))

test("native task host cannot register a late tool after shutdown interrupts startup", () =>
  fixture(async root => {
    const f = host(root)

    try {
      const settled = await Promise.allSettled([
        f.emit("session_start"),
        f.emit("session_shutdown"),
      ])

      assert.deepEqual(
        settled.map(result => result.status),
        ["fulfilled", "fulfilled"],
      )
      assert.equal(f.tools.length, 0)
      assert.deepEqual(f.opened, [])
      assert.deepEqual(f.closed, [])
    } finally {
      await f.cleanup()
    }
  }))

test("native task host stops before opening storage when directory preparation fails", () =>
  fixture(async root => {
    const failure = new TaskStoreError({
      code: "io",
      message: "Could not prepare task storage",
    })
    const f = host(root, { prepareDatabase: Effect.fail(failure) })

    try {
      await f.emit("session_start")
      assert.equal(f.tools.length, 0)
      assert.equal(f.opened.length, 1)
      assert.equal(f.opened[0], failure)
      assert.equal(existsSync(join(root, "tasks.sqlite")), false)
      assert.deepEqual(f.closed, [])
    } finally {
      await f.cleanup()
    }
  }))

test("native task host reports initialization failure without registering a broken tool", () =>
  fixture(async root => {
    const f = host(root, { databasePath: root })

    try {
      await f.emit("session_start")
      assert.equal(f.tools.length, 0)
      assert.equal(f.opened.length, 1)
      const error = f.opened[0]

      assert.ok(error?._tag === "TaskStoreError")
      assert.equal(error.code, "invalid_path")
      assert.equal(
        error.message,
        "Database must be an owner-private regular file, not a symlink",
      )
      assert.deepEqual(f.closed, [])
      await f.emit("session_shutdown")
      await f.emit("session_shutdown")
      assert.equal(f.opened.length, 1)
    } finally {
      await f.cleanup()
    }
  }))
