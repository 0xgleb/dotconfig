import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import { Either, Schema } from "effect"
import { TaskIdSchema } from "./model.ts"
import { decodeIssueReference } from "./identity.ts"
import { decodeIssueNextQuery } from "./next.ts"
import {
  getManagerBinding,
  registerManagerBinding,
} from "../shared/manager-binding.ts"
import {
  TaskContinuationError,
  latestTaskNextQuery,
  readTaskContinuation,
  registerTaskContinuation,
  formatTaskContinuation,
} from "./continuation.ts"

const decoded = decodeIssueNextQuery({
  repository: "owner/repository",
  project: "personal",
})
assert.ok(Either.isRight(decoded))
const query = decoded.right

const issueReference = (repository = query.repository) => {
  const parsed = decodeIssueReference({ repository, number: 7 })
  assert.ok(Either.isRight(parsed))
  return parsed.right
}

const ctx = {
  cwd: "/work/repository",
  sessionManager: { getSessionId: () => "session-one" },
}

const events = () => {
  const handlers = new Map<string, Set<(value: unknown) => void>>()

  return {
    events: {
      on: (name: string, callback: (value: unknown) => void) => {
        const listeners = handlers.get(name) ?? new Set()
        handlers.set(name, listeners)
        listeners.add(callback)

        return () => {
          listeners.delete(callback)
        }
      },
      emit: (name: string, value: unknown) => {
        for (const callback of handlers.get(name) ?? []) callback(value)
      },
    },
  }
}

const branch = (kind: "verified" | "partial" | "unknown" = "verified") => {
  const issue = { repository: query.repository, number: 7 }

  const viewer = { id: "viewer-id", login: "owner" }

  const status = {
    projectId: "project-id",
    fieldId: "status-field",
    optionId: "in-progress",
  }

  const target = {
    issue,
    viewer,
    itemId: "item-id",
    issueNodeId: "issue-id",
    inProgress: status,
  }

  const observed = {
    ...target,
    projectId: status.projectId,
    state: "open",
    archived: false,
    assignees: [viewer],
    status: { fieldId: status.fieldId, optionId: status.optionId },
  }

  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "pick",
            name: "task",
            arguments: { action: "next", query },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "task",
        toolCallId: "pick",
        details: {
          outcome: {
            kind: "issue_next",
            result: {
              kind: "pickup",
              observation: {
                viewer,
                inProgress: status,
                excludedAssignments: [],
                selection: { kind: "selected", issue, assessments: [] },
                selected: {
                  kind: "issue",
                  ...target,
                  state: "open",
                  assignees: [viewer],
                  status: status.optionId,
                  priority: { kind: "number", value: 1 },
                  effort: { kind: "number", value: 1 },
                },
              },
              receipt: {
                kind,
                observed,
                verification: "observed_not_exclusive",
                trace: {
                  target,
                  stage: "readback",
                  assignment: "not_needed",
                  status: "not_needed",
                },
              },
            },
          },
          output: "complete",
        },
      },
    },
  ]
}

test("continuation restores the validated query from a completed task-next call", () => {
  const restored = latestTaskNextQuery(branch())
  assert.ok(Either.isRight(restored))
  assert.deepEqual(restored.right, query)
})

test("malformed task receipt tags fail explicitly instead of being coerced into a stop", () => {
  for (const kind of [7, {}, null]) {
    const result = latestTaskNextQuery([
      ...branch(),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "task",
          toolCallId: "malformed",
          details: { outcome: { kind } },
        },
      },
    ])
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_state")
  }
})

for (const kind of ["partial", "unknown"] as const) {
  test(`continuation does not retry uncertain pickup: ${kind}`, () => {
    const restored = latestTaskNextQuery(branch(kind))
    assert.ok(Either.isRight(restored))
    assert.equal(restored.right, undefined)
  })
}

test("a same-session native reader is used and releasing it ends access", async () => {
  const pi = events()
  let reads = 0
  const release = registerTaskContinuation(pi, ctx, async received => {
    reads++
    assert.deepEqual(received, query)
    return Either.right("Selected issue and persisted tasks")
  })
  const signal = new AbortController().signal
  assert.deepEqual(
    await readTaskContinuation(pi, ctx, query, signal),
    Either.right("Selected issue and persisted tasks"),
  )
  assert.equal(reads, 1)
  release()
  assert.ok(Either.isLeft(await readTaskContinuation(pi, ctx, query, signal)))
  assert.equal(reads, 1)
})

for (const changed of [
  { ...ctx, cwd: "/another/repository" },
  { ...ctx, sessionManager: { getSessionId: () => "another-session" } },
]) {
  test(`a native reader cannot supply another worker scope: ${changed.cwd}`, async () => {
    const pi = events()
    let reads = 0
    registerTaskContinuation(pi, ctx, async () => {
      reads++
      return Either.right("work")
    })
    assert.ok(
      Either.isLeft(
        await readTaskContinuation(
          pi,
          changed,
          query,
          new AbortController().signal,
        ),
      ),
    )
    assert.equal(reads, 0)
  })
}

test("interruption before a read cannot invoke the native source", async () => {
  const pi = events()
  let reads = 0
  registerTaskContinuation(pi, ctx, async () => {
    reads++
    return Either.right("work")
  })
  const controller = new AbortController()
  controller.abort()
  const result = await readTaskContinuation(pi, ctx, query, controller.signal)
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "interrupted")
  assert.equal(reads, 0)
})

test("conflicting native providers cannot choose a source by listener order", async () => {
  const pi = events()
  registerTaskContinuation(pi, ctx, async () => Either.right("one"))
  registerTaskContinuation(pi, ctx, async () => Either.right("two"))
  const result = await readTaskContinuation(
    pi,
    ctx,
    query,
    new AbortController().signal,
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_state")
})

test("continuation identifies the selected issue and asks for the same task-next query", () => {
  const content = formatTaskContinuation(query, issueReference(), undefined)
  assert.match(content, /owner\/repository#7/)
  assert.match(content, /task next/)
  assert.match(content, /persisted tasks/)
  assert.ok(content.length <= 4_000)
})

const scheduler = () => {
  const source = readFileSync(
    new URL("../classified-workflows/index.ts", import.meta.url),
    "utf8",
  )
  const start = source.indexOf("  const clearTaskContinuationTimer =")
  const end = source.indexOf("  const clearManualReloadPending =", start)
  assert.ok(start >= 0 && end > start)

  let timer: (() => void | Promise<void>) | undefined
  let allowed = true
  let editor = ""
  let sessionId = "session-one"
  const sent: unknown[] = []

  const context = {
    ...ctx,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () =>
        branch().map((entry, index) => ({ ...entry, id: `entry-${index}` })),
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { getEditorText: () => editor, notify: () => {} },
  }

  const pi = {
    ...events(),
    sendMessage: (message: unknown) => {
      sent.push(message)
    },
  }

  const controls = runInNewContext(
    `
    let taskContinuationTimer;
    let taskContinuationAbort;
    let taskContinuationEpoch = 0;
    let pendingActionRemediation;
    let continuationPaused = false;
    const workflowLifecycleActive = true;
    const capabilityCircuit = { open: false };
    const manualReloadPending = false;
    const TASK_CONTINUATION_QUIET_MS = 1;
    const TASK_MESSAGE = "task";
    ${stripTypeScriptTypes(source.slice(start, end))}
    ({ schedule: scheduleTaskContinuation, clear: clearTaskContinuationTimer });
  `,
    {
      pi,
      Either,
      AbortController,
      latestTaskNextQuery,
      readTaskContinuation,
      getManagerBinding,
      ownerAllowance: {
        admit: () => (allowed ? Either.right(undefined) : Either.left({})),
      },
      setTimeout: (callback: () => void | Promise<void>) => {
        timer = callback
        return 1
      },
      clearTimeout: () => {
        timer = undefined
      },
    },
  ) as { schedule: (value: typeof context) => void; clear: () => void }

  return {
    pi,
    context,
    sent,
    schedule: () => controls.schedule(context),
    flush: async () => {
      const callback = timer
      assert.ok(
        callback,
        "a confirmed selection must arm the existing quiet timer",
      )
      timer = undefined
      await callback()
    },
    expire: () => {
      allowed = false
    },
    edit: () => {
      editor = "unfinished user input"
    },
    replaceSession: () => {
      sessionId = "replacement-session"
    },
    clear: controls.clear,
    hasTimer: () => timer !== undefined,
  }
}

test("existing worker quiet continuation reads current task-next work before waking", async () => {
  const runtime = scheduler()
  let reads = 0
  registerTaskContinuation(runtime.pi, runtime.context, async () => {
    reads++
    return Either.right("Continue selected persisted work")
  })
  runtime.schedule()
  await runtime.flush()
  assert.equal(reads, 1)
  assert.equal(runtime.sent.length, 1)
})

for (const change of ["expire", "edit", "replaceSession", "clear"] as const) {
  test(
    `a pending observation cannot wake after ${change}`,
    { timeout: 5000 },
    async () => {
      const runtime = scheduler()
      let finish: (
        value: Either.Either<string | undefined, TaskContinuationError>,
      ) => void = () => assert.fail("Reader not entered")
      let started: () => void = () => assert.fail("Reader not started")

      const ready = new Promise<void>(resolve => {
        started = resolve
      })
      const result = new Promise<
        Either.Either<string | undefined, TaskContinuationError>
      >(resolve => {
        finish = resolve
      })

      registerTaskContinuation(runtime.pi, runtime.context, () => {
        started()
        return result
      })
      runtime.schedule()
      const delivering = runtime.flush()
      await ready

      runtime[change]()
      finish(Either.right("Stale work must not wake"))
      await delivering

      assert.equal(runtime.sent.length, 0)
      runtime.clear()
    },
  )
}

test("no eligible issue ends the wake without another timer or model turn", async () => {
  const runtime = scheduler()
  registerTaskContinuation(runtime.pi, runtime.context, async () =>
    Either.right(undefined),
  )
  runtime.schedule()
  await runtime.flush()
  assert.equal(runtime.sent.length, 0)
  assert.equal(runtime.hasTimer(), false)
})

for (const role of ["manager", "manager-unavailable"] as const) {
  test(`task continuation does not wake ${role}`, () => {
    const runtime = scheduler()
    registerManagerBinding(
      runtime.pi as Parameters<typeof registerManagerBinding>[0],
      () =>
        role === "manager"
          ? {
              role,
              workerSessionId: "selected-worker",
              workerCwd: runtime.context.cwd,
            }
          : { role, message: "No worker selected" },
    )
    runtime.schedule()
    assert.equal(runtime.hasTimer(), false)
    assert.equal(runtime.sent.length, 0)
  })
}

test("escaped long task text stays within the total prompt budget with complete-detail access", () => {
  const decodedLong = decodeIssueNextQuery({
    repository: `${"o".repeat(39)}/${"r".repeat(100)}`,
    project: "personal",
    mode: "implementation",
  })
  assert.ok(Either.isRight(decodedLong))
  const query = decodedLong.right
  const issue = issueReference(query.repository)
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    id: Schema.decodeUnknownSync(TaskIdSchema)(
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    ),
    text: "\\".repeat(1000),
    status: "todo" as const,
    blocker: index === 7 ? null : '"'.repeat(1000),
  }))
  const page = { issue, revision: 1, tasks, next: tasks[7]!.id }
  const original = JSON.stringify(page)

  const content = formatTaskContinuation(query, issue, page)

  assert.ok(content.length <= 4_000)
  assert.match(content, /omitted/)
  assert.match(content, /task getIssue\/read/)
  assert.equal(JSON.stringify(page), original)
})
