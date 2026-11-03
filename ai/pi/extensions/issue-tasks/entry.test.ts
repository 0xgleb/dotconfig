import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import issueTaskExtension from "./index.ts"
import type { IssueTaskTool } from "./tool.ts"

const parent = fileURLToPath(
  new URL("../../../../.tmp/issue-task-host-tests/", import.meta.url),
)
type Handler = (event: unknown, context: unknown) => unknown
const fixture = async (work: (root: string) => Promise<void>) => {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "entry-"))

  try {
    await work(root)
  } finally {
    rmSync(root, { recursive: true })
  }
}

const start = (root: string) => {
  const handlers = new Map<string, Handler>()
  const tools = new Map<string, IssueTaskTool>()
  const active = ["todo"]
  const loadouts: string[][] = []
  const messages: { message: unknown; options: unknown }[] = []
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    registerTool: (tool: IssueTaskTool) => {
      tools.set(tool.name, tool)
      active.push(tool.name)
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      loadouts.push(names)
    },
    sendMessage: (message: unknown, options: unknown) => {
      messages.push({ message, options })
    },
  } as unknown as ExtensionAPI
  const cwd = join(root, "repository")
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  const context = {
    cwd,
    sessionManager: { getSessionId: () => "worker-session" },
  } as unknown as Parameters<IssueTaskTool["execute"]>[4]

  // XDG_STATE_HOME is the source-owned, non-secret state-path input used by the registry.
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = root
  try {
    issueTaskExtension(pi)
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }

  const emit = async (name: string) => {
    const handler = handlers.get(name)
    assert.ok(handler, `Missing ${name} handler`)
    await handler({ type: name }, context)
  }

  const tool = () => {
    const value = tools.get("task")
    assert.ok(value)
    return value
  }

  const invoke = (request: unknown, id: string) =>
    tool().execute(
      id,
      request as Parameters<IssueTaskTool["execute"]>[1],
      undefined,
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
    invoke,
    cleanup,
    tools,
    active,
    loadouts,
    messages,
    databasePath: join(root, "pi", "agent-registry", "registry.sqlite"),
  }
}

test("task entrypoint uses the registry database and enables ordinary work without touching todo", () =>
  fixture(async root => {
    const f = start(root)
    const issue = { repository: "owner/repo", number: 7 }

    try {
      assert.equal(existsSync(f.databasePath), false)
      await f.emit("session_start")
      assert.equal(existsSync(f.databasePath), true)
      assert.deepEqual(f.active, ["todo", "task"])
      assert.deepEqual(f.loadouts, [])
      const saved = (
        await f.invoke(
          {
            action: "apply",
            issues: [issue],
            operations: [
              { op: "add", issue, key: "one", text: "Worker requirement" },
            ],
          },
          "add-call",
        )
      ).details.outcome

      assert.ok(saved.kind === "saved")
      const id = saved.result.created[0]?.id
      assert.ok(id)
      const cancelled = (
        await f.invoke(
          {
            action: "apply",
            issues: [issue],
            operations: [
              {
                op: "status",
                target: { issue, task: { kind: "existing", id } },
                status: "cancelled",
              },
            ],
          },
          "cancel-call",
        )
      ).details.outcome

      assert.ok(cancelled.kind === "failed")
      assert.equal(cancelled.code, "unauthorized")
      const page = (
        await f.invoke(
          { action: "read", issue, page: { limit: 10 } },
          "read-call",
        )
      ).details.outcome

      assert.ok(page.kind === "page")
      assert.equal(page.page.tasks.length, 1)
      assert.equal(page.page.tasks[0]?.status, "todo")
      assert.deepEqual(f.messages, [])
    } finally {
      await f.cleanup()
    }
  }))

test("task entrypoint reports a real directory-creation failure without leaking its path", () =>
  fixture(async root => {
    const f = start(root)
    assert.equal(existsSync(join(root, "pi")), false)
    writeFileSync(join(root, "pi"), "not a directory", { mode: 0o600 })

    try {
      await f.emit("session_start")
      assert.equal(f.tools.size, 0)
      assert.equal(existsSync(f.databasePath), false)
      assert.deepEqual(f.active, ["todo"])
      assert.deepEqual(f.messages, [
        {
          message: {
            customType: "task-host-failure",
            content: "Task host initialization failed (io).",
            details: { phase: "initialization", code: "io" },
            display: true,
          },
          options: { triggerTurn: false },
        },
      ])
      assert.ok(!JSON.stringify(f.messages).includes(root))
    } finally {
      await f.cleanup()
    }
  }))

test("task entrypoint makes a real startup failure visible with only bounded diagnostics", () =>
  fixture(async root => {
    const f = start(root)
    mkdirSync(f.databasePath, { recursive: true, mode: 0o700 })

    try {
      await f.emit("session_start")
      assert.equal(f.tools.size, 0)
      assert.deepEqual(f.active, ["todo"])
      assert.deepEqual(f.messages, [
        {
          message: {
            customType: "task-host-failure",
            content: "Task host initialization failed (invalid_path).",
            details: { phase: "initialization", code: "invalid_path" },
            display: true,
          },
          options: { triggerTurn: false },
        },
      ])
      assert.ok(!JSON.stringify(f.messages).includes(root))
    } finally {
      await f.cleanup()
    }
  }))
