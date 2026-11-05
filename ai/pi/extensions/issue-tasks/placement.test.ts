import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { execFile, type ChildProcess } from "node:child_process"
import {
  createGitHubCliProjectPlacement,
  type GitHubCliLaunch,
} from "./github-cli.ts"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, Deferred, Effect, Exit } from "effect"
import { IssuePickupWriteError } from "./pickup.ts"
import { openSqliteTaskStore, type SqliteTaskStore } from "./sqlite-store.ts"
import { issueKey } from "./identity.ts"
import {
  createTaskTool,
  type TaskToolOptions,
  type IssueTaskTool,
} from "./tool.ts"
import {
  createGitHubProjectPlacement,
  GITHUB_PROJECT_MEMBERSHIP_DOCUMENT,
  GITHUB_PROJECT_PLACEMENT_DOCUMENT,
  type GitHubProjectPlacementOptions,
  type ProjectPlacementObservation,
} from "./placement.ts"

const parent = fileURLToPath(
  new URL(
    "../../../../.tmp/issue-task-consumers/placement-tests/",
    import.meta.url,
  ),
)
const personal = "PVT_kwHOAl_tIc4BpO1U"
const dataclique = "PVT_kwDOCA_DB84BkDqI"
const pageInfo = { hasNextPage: false, endCursor: null }
const ownerIssue = { repository: "0xgleb/dotconfig", number: 179 }
const context = () => ({
  actorId: "fixture",
  requestId: randomUUID(),
  now: 1,
  cancellation: "forbidden" as const,
})
const fixture = async (work: (store: SqliteTaskStore) => Promise<void>) => {
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, "placement-"))
  const store = await Effect.runPromise(
    openSqliteTaskStore({ databasePath: join(root, "tasks.sqlite") }),
  )
  try {
    await work(store)
  } finally {
    await Effect.runPromise(store.close())
    rmSync(root, { recursive: true })
  }
}
const seed = (
  store: SqliteTaskStore,
  issue = ownerIssue,
  request = context(),
) =>
  store.apply(
    {
      issues: [issue],
      operations: [{ op: "add", issue, key: "work", text: "Fixture work" }],
    },
    request,
  )
const run = Effect.runPromise
const invocation = { sessionId: "fixture-session", toolCallId: "original-call" }

const backend = () => {
  const calls: string[] = []
  const members = new Map<
    string,
    { readonly project: string; readonly archived: boolean }
  >()
  const references = new Map<
    string,
    { readonly repository: string; readonly number: number }
  >()
  const payload = (
    repository: string,
    number: number,
    nodes: readonly unknown[],
    paging: { hasNextPage: boolean; endCursor: string | null } = pageInfo,
  ) =>
    JSON.stringify({
      data: {
        repository: {
          nameWithOwner: repository,
          issue: {
            id: `node-${repository}-${number}`,
            number,
            repository: { nameWithOwner: repository },
            projectItems: { nodes, pageInfo: paging },
          },
        },
      },
    })
  const ports: {
    read: GitHubProjectPlacementOptions["read"]
    write: GitHubProjectPlacementOptions["write"]
  } = {
    read: request =>
      Effect.sync(() => {
        assert.equal(request.document, GITHUB_PROJECT_MEMBERSHIP_DOCUMENT)
        assert.equal(request.variables.first, 100)
        const repository = `${request.variables.owner}/${request.variables.name}`
        const number = request.variables.number
        const key = `${repository}#${number}`
        calls.push(`read:${key}`)
        references.set(`node-${repository}-${number}`, { repository, number })
        const member = members.get(key)
        return payload(
          repository,
          number,
          member === undefined
            ? []
            : [
                {
                  id: `item-${key}`,
                  isArchived: member.archived,
                  project: { id: member.project },
                },
              ],
        )
      }),
    write: (request, onDispatch) =>
      Effect.sync(() => {
        assert.equal(request.document, GITHUB_PROJECT_PLACEMENT_DOCUMENT)
        const reference = references.get(request.variables.input.contentId)
        assert.ok(reference)
        const key = `${reference.repository}#${reference.number}`
        const expected = reference.repository.startsWith("dataclique/")
          ? dataclique
          : personal
        assert.equal(request.variables.input.projectId, expected)
        calls.push(`write:${key}`)
        onDispatch()
        members.set(key, { project: expected, archived: false })
        return JSON.stringify({
          data: {
            addProjectV2ItemById: {
              item: {
                id: `item-${key}`,
                isArchived: false,
                project: { id: expected },
                content: {
                  id: request.variables.input.contentId,
                  number: reference.number,
                  repository: { nameWithOwner: reference.repository },
                },
              },
            },
          },
        })
      }),
  }
  return {
    calls,
    members,
    ports,
    payload,
    client: () => createGitHubProjectPlacement(ports),
  }
}

const toolContext = {
  sessionManager: { getSessionId: () => "placement-session" },
} as Parameters<IssueTaskTool["execute"]>[4]
const toolOptions = (
  store: SqliteTaskStore,
  placeAffected: TaskToolOptions["placeAffected"],
): TaskToolOptions => ({
  store,
  ...(placeAffected === undefined ? {} : { placeAffected }),
  contextForCall: call =>
    Effect.succeed({
      actorId: call.sessionId,
      requestId: call.toolCallId,
      now: 1,
      cancellation: "forbidden",
    }),
  renderOutput: outcome => Effect.succeed(JSON.stringify(outcome)),
})
const invokeAdd = (tool: IssueTaskTool, signal?: AbortSignal) =>
  tool.execute(
    "placement-call",
    {
      action: "apply",
      issues: [ownerIssue],
      operations: [
        {
          op: "add",
          issue: ownerIssue,
          key: "work",
          text: "Saved through actual task adapter",
        },
      ],
    },
    signal,
    undefined,
    toolContext,
  )

for (const mode of ["linked", "absent"]) {
  test(`native Project placement uses actual fixed-query subprocess transport: ${mode}`, async t =>
    fixture(async store => {
      const saved = await run(seed(store))
      const children: ChildProcess[] = []
      const closures: Promise<void>[] = []
      const launch: GitHubCliLaunch = (_args, options, callback) => {
        const program = fileURLToPath(
          new URL("./test-fixtures/github-placement-cli.mjs", import.meta.url),
        )
        const child = execFile(
          process.execPath,
          [program, mode],
          options,
          callback,
        )
        children.push(child)
        closures.push(
          new Promise(resolve => child.once("close", () => resolve())),
        )
        return child
      }
      t.after(async () => {
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL")
        await Promise.all(closures)
      })
      const client = createGitHubCliProjectPlacement({
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        launch,
      })
      const result = await run(client.placeAffected(saved, invocation))
      assert.equal(result[0]?.kind, mode === "linked" ? "linked" : "unknown")
      assert.equal(children.length, mode === "linked" ? 1 : 3)
    }))
}

test("task adapter preserves the exact saved receipt when Project placement returns a failure", () =>
  fixture(async store => {
    let retained: unknown
    const tool = createTaskTool(
      toolOptions(store, (saved, call) =>
        Effect.sync(() => {
          retained = saved
          assert.deepEqual(call, {
            toolCallId: "placement-call",
            sessionId: "placement-session",
          })
          const issue = saved.issues[0]?.issue
          assert.ok(issue)
          return [
            {
              kind: "failed" as const,
              issue,
              project: "personal" as const,
              reason: "transport_error" as const,
            },
          ]
        }),
      ),
    )
    const result = await invokeAdd(tool)
    assert.ok(result.details.outcome.kind === "saved")
    assert.equal(result.details.outcome.result, retained)
    assert.equal(result.details.outcome.projectPlacement?.[0]?.kind, "failed")
    assert.equal(result.isError, true)
  }))

test("unexpected post-save placement defects cannot erase or resubmit committed local tasks", () =>
  fixture(async store => {
    const tool = createTaskTool(
      toolOptions(store, () => Effect.die("private placement defect")),
    )
    const result = await invokeAdd(tool)
    assert.ok(result.details.outcome.kind === "saved")
    assert.equal(result.details.outcome.result.receipt, "committed")
    assert.equal(result.details.outcome.projectPlacementFailure, "unavailable")
    assert.equal(
      result.details.outcome.projectPlacement?.[0]?.kind,
      "not_attempted",
    )
    const replay = await invokeAdd(tool)
    assert.ok(replay.details.outcome.kind === "saved")
    assert.equal(replay.details.outcome.result.receipt, "replayed")
    assert.deepEqual(
      replay.details.outcome.result.created,
      result.details.outcome.result.created,
    )
    assert.ok(!JSON.stringify(result).includes("private placement defect"))
  }))

test("stop after SQL save retains saved truth and possible Project dispatch without recovery", () =>
  fixture(async store => {
    const entered = Effect.runSync(Deferred.make<void>())
    const tool = createTaskTool(
      toolOptions(store, (saved, _call, observe) =>
        Effect.gen(function* () {
          const issue = saved.issues[0]?.issue
          assert.ok(issue)
          observe?.([{ kind: "unknown", issue, project: "personal" }])
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }),
      ),
    )
    const controller = new AbortController()
    const pending = invokeAdd(tool, controller.signal)
    assert.equal(
      await Promise.race([
        run(Deferred.await(entered)).then(() => true),
        pending.then(() => false),
      ]),
      true,
    )
    controller.abort()
    const result = await pending
    assert.ok(result.details.outcome.kind === "saved")
    assert.equal(result.details.outcome.result.receipt, "committed")
    assert.equal(result.details.outcome.projectPlacementFailure, "interrupted")
    assert.equal(result.details.outcome.projectPlacement?.[0]?.kind, "unknown")
  }))

test("read-only task actions never ensure or mutate Project membership", () =>
  fixture(async store => {
    await run(seed(store))
    const tool = createTaskTool(
      toolOptions(store, () => assert.fail("read cannot place")),
    )
    const result = await tool.execute(
      "read-only",
      { action: "read", issue: ownerIssue, page: { limit: 1 } },
      undefined,
      undefined,
      toolContext,
    )
    assert.equal(result.details.outcome.kind, "page")
  }))

for (const issue of [
  ownerIssue,
  { repository: "dataclique/yielduck", number: 515 },
]) {
  test(`saved tasks automatically link only their configured Project: ${issue.repository}`, () =>
    fixture(async store => {
      const saved = await run(seed(store, issue))
      const before = JSON.stringify(saved)
      const source = backend()
      const result = await run(source.client().placeAffected(saved, invocation))
      assert.equal(result.length, 1)
      assert.ok(result[0]?.kind === "linked")
      assert.equal(
        result[0].project,
        issue.repository.startsWith("dataclique/") ? "dataclique" : "personal",
      )
      assert.deepEqual(source.calls, [
        `read:${issue.repository}#${issue.number}`,
        `write:${issue.repository}#${issue.number}`,
        `read:${issue.repository}#${issue.number}`,
      ])
      assert.equal(
        JSON.stringify(saved),
        before,
        "placement must not rewrite the local receipt",
      )
    }))
}

test("transfer A→B→C places every affected owner once, excluding untouched scope and dependency-only issues", () =>
  fixture(async store => {
    const a = { repository: "0xgleb/dotconfig", number: 1 }
    const b = { repository: "dataclique/yielduck", number: 2 }
    const c = { repository: "0xgleb/dotconfig", number: 3 }
    const untouched = { repository: "0xgleb/dotconfig", number: 4 }
    const dependency = { repository: "0xgleb/dotconfig", number: 5 }
    const prerequisite = await run(seed(store, dependency))
    const id = prerequisite.created[0]?.id
    assert.ok(id)
    const target = { issue: a, task: { kind: "added", key: "work" } }
    const saved = await run(
      store.apply(
        {
          issues: [a, b, c, untouched, dependency],
          operations: [
            {
              op: "add",
              issue: a,
              key: "work",
              text: "Initial",
              dependsOn: [
                { issue: dependency, task: { kind: "existing", id } },
              ],
            },
            { op: "edit", target, text: "Edited" },
            { op: "status", target, status: "doing" },
            { op: "block", target, reason: "Fixture blocker" },
            { op: "transfer", target, toIssue: b },
            { op: "transfer", target, toIssue: c },
          ],
        },
        context(),
      ),
    )
    const source = backend()
    const result = await run(source.client().placeAffected(saved, invocation))
    assert.deepEqual(
      new Set(result.map(row => issueKey(row.issue))),
      new Set([`${a.repository}#1`, `${b.repository}#2`, `${c.repository}#3`]),
    )
    assert.equal(
      source.calls.filter(call => call.startsWith("write:")).length,
      3,
    )
    assert.ok(result.every(row => row.kind === "linked"))
  }))

test("unsupported repository owners do not guess a personal Project or launch network I/O", () =>
  fixture(async store => {
    const source = backend()
    const saved = await run(
      seed(store, { repository: "another/repository", number: 1 }),
    )
    const result = await run(source.client().placeAffected(saved, invocation))
    assert.equal(result[0]?.kind, "not_attempted")
    assert.ok(result[0]?.kind === "not_attempted")
    assert.equal(result[0].reason, "unsupported_owner")
    assert.deepEqual(source.calls, [])
  }))

test("later-page archived membership is linked without duplicate add or unarchive", () =>
  fixture(async store => {
    const saved = await run(seed(store))
    const source = backend()
    source.ports.read = request =>
      Effect.sync(() => {
        source.calls.push(`read:${request.variables.after}`)
        return source.payload(
          ownerIssue.repository,
          ownerIssue.number,
          request.variables.after === null
            ? [
                {
                  id: "other-item",
                  isArchived: false,
                  project: { id: "other-project" },
                },
              ]
            : [
                {
                  id: "existing-item",
                  isArchived: true,
                  project: { id: personal },
                },
              ],
          request.variables.after === null
            ? { hasNextPage: true, endCursor: "next" }
            : pageInfo,
        )
      })
    const result = await run(source.client().placeAffected(saved, invocation))
    assert.ok(result[0]?.kind === "linked")
    assert.equal(result[0].archived, true)
    assert.deepEqual(source.calls, ["read:null", "read:next"])
  }))

test("incomplete membership data is not proof of absence and cannot trigger add", () =>
  fixture(async store => {
    const saved = await run(seed(store))
    const source = backend()
    source.ports.read = () =>
      Effect.succeed(
        JSON.stringify({
          data: {
            repository: {
              nameWithOwner: ownerIssue.repository,
              issue: {
                id: "issue-id",
                number: ownerIssue.number,
                repository: { nameWithOwner: ownerIssue.repository },
                projectItems: { nodes: null, pageInfo },
              },
            },
          },
        }),
      )
    const result = await run(source.client().placeAffected(saved, invocation))
    assert.ok(result[0]?.kind === "failed")
    assert.equal(result[0].reason, "invalid_response")
    assert.ok(!source.calls.some(call => call.startsWith("write:")))
  }))

for (const visible of [true, false]) {
  test(`ambiguous add reconciles membership once without resending: visible=${visible}`, () =>
    fixture(async store => {
      const saved = await run(seed(store))
      const source = backend()
      source.ports.write = (_request, onDispatch) =>
        Effect.suspend(() => {
          source.calls.push("ambiguous-write")
          onDispatch()
          if (visible)
            source.members.set(
              `${ownerIssue.repository}#${ownerIssue.number}`,
              { project: personal, archived: false },
            )
          return Effect.fail(
            new IssuePickupWriteError({
              dispatch: "possible",
              message: "private transport detail",
            }),
          )
        })
      const result = await run(source.client().placeAffected(saved, invocation))
      assert.equal(result[0]?.kind, visible ? "linked" : "unknown")
      assert.equal(
        source.calls.filter(call => call === "ambiguous-write").length,
        1,
      )
      assert.ok(!JSON.stringify(result).includes("private transport detail"))
    }))
}

test("local replay reconciles existing membership without another remote add or task write", () =>
  fixture(async store => {
    const call = context()
    const saved = await run(seed(store, ownerIssue, call))
    const source = backend()
    await run(source.client().placeAffected(saved, invocation))
    const replay = await run(seed(store, ownerIssue, call))
    assert.equal(replay.receipt, "replayed")
    const result = await run(source.client().placeAffected(replay, invocation))
    assert.ok(result[0]?.kind === "linked")
    assert.equal(
      source.calls.filter(call => call.startsWith("write:")).length,
      1,
    )
    assert.deepEqual(replay.created, saved.created)
  }))

test("stop during possible add retains observation and performs no recovery read", () =>
  fixture(async store => {
    const saved = await run(seed(store))
    const source = backend()
    const entered = Effect.runSync(Deferred.make<void>())
    source.ports.write = (_request, onDispatch) =>
      Effect.gen(function* () {
        source.calls.push("write-pending")
        onDispatch()
        yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      })
    let observed: readonly ProjectPlacementObservation[] = []
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(
      source.client().placeAffected(saved, invocation, value => {
        observed = value
      }),
      { signal: controller.signal },
    )
    assert.equal(
      await Promise.race([
        run(Deferred.await(entered)).then(() => true),
        pending.then(() => false),
      ]),
      true,
    )
    controller.abort()
    const exit = await pending
    assert.ok(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause))
    assert.equal(observed[0]?.kind, "unknown")
    assert.deepEqual(source.calls, [
      `read:${ownerIssue.repository}#${ownerIssue.number}`,
      "write-pending",
    ])
  }))
