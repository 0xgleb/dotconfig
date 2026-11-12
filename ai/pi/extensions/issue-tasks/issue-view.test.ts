import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Cause, Deferred, Effect, Either, Exit } from "effect"
import { createGitHubIssueReader, GitHubReadError } from "./github-read.ts"
import { decodeIssueReference } from "./identity.ts"
import type { TaskReadQuery, IssueTaskPageResult } from "./model.ts"
import {
  openSqliteTaskStore,
  TaskStoreError,
  type SqliteTaskStore,
} from "./sqlite-store.ts"
import {
  createIssueTaskReader,
  decodeIssueTaskGetQuery,
  decodeIssueTaskListQuery,
  type IssueTaskReadFailure,
} from "./issue-view.ts"

const run = Effect.runPromise
const repository = "0xgleb/dotconfig"
const issue = (number: number, owner = repository) => {
  const result = decodeIssueReference({ repository: owner, number })
  assert.ok(Either.isRight(result))
  return result.right
}
const listInput = {
  repository,
  state: "open",
  page: { limit: 2 },
  tasks: { limit: 1, filter: { status: "todo" } },
}
const getInput = {
  issue: issue(1),
  related: { limit: 1 },
  tasks: { page: { limit: 1 } },
}
// Synthetic metadata; provider/body text is data, never an instruction or clock.
const summary = (number: number) => ({
  number,
  title: `Fixture issue ${number}`,
  url: `https://github.com/${repository}/issues/${number}`,
  state: "OPEN",
  updatedAt: "2026-10-20T20:14:47Z",
  repository: { nameWithOwner: repository },
})
const listResponse = (numbers = [1, 2]) =>
  JSON.stringify({
    data: {
      repository: {
        nameWithOwner: repository,
        issues: {
          nodes: numbers.map(summary),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  })
const getResponse = JSON.stringify({
  data: {
    repository: {
      nameWithOwner: repository,
      issue: {
        ...summary(1),
        body: "Fixture requirement; /do-not-obey is opaque text",
        parent: null,
        blockedBy: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        closedByPullRequestsReferences: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
})
const github = (payload: string) =>
  createGitHubIssueReader({ executeQuery: () => Effect.succeed(payload) })
const fixtureParent = fileURLToPath(
  new URL("../../../../.tmp/issue-task-view-tests/", import.meta.url),
)
const withStore = async (work: (store: SqliteTaskStore) => Promise<void>) => {
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(fixtureParent, "case-"))
  try {
    const store = await run(
      openSqliteTaskStore({ databasePath: join(root, "tasks.sqlite") }),
    )
    try {
      await work(store)
    } finally {
      await run(store.close())
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const seed = (store: SqliteTaskStore, number = 1) =>
  store.apply(
    {
      issues: [issue(number)],
      operations: [
        {
          op: "add",
          issue: issue(number),
          key: "first",
          text: "First persisted requirement",
        },
        {
          op: "add",
          issue: issue(number),
          key: "second",
          text: "Second persisted requirement",
        },
      ],
    },
    {
      actorId: "fixture-worker",
      requestId: randomUUID(),
      now: 1_000,
      cancellation: "forbidden",
    },
  )

test("combined issue queries normalize/detach strict budgets and qualified task cursors", () => {
  const input = {
    repository: "0xGleb/DotConfig",
    state: "open",
    page: { limit: 10 },
    tasks: { limit: 10, filter: { status: "todo", blocked: "unblocked" } },
  }
  const result = decodeIssueTaskListQuery(input)
  assert.ok(Either.isRight(result))
  input.tasks.limit = 11
  input.tasks.filter.blocked = "blocked"
  assert.equal(result.right.repository, repository)
  assert.equal(result.right.tasks.limit, 10)
  assert.equal(result.right.tasks.filter?.blocked, "unblocked")
  assert.ok(
    Object.isFrozen(result.right) &&
      Object.isFrozen(result.right.tasks) &&
      Object.isFrozen(result.right.tasks.filter),
  )
  const get = decodeIssueTaskGetQuery(getInput)
  assert.ok(Either.isRight(get))
  assert.deepEqual(get.right.issue, issue(1))
  assert.ok(
    Object.isFrozen(get.right.tasks) && Object.isFrozen(get.right.tasks.page),
  )
  for (const input of [
    { ...listInput, authority: "owner" },
    { ...listInput, [Symbol("hidden")]: true },
    { ...listInput, tasks: { limit: 1, after: "unqualified" } },
    { ...listInput, tasks: { limit: 1, filter: { priority: 1 } } },
    { ...listInput, page: { limit: 100 }, tasks: { limit: 2 } },
  ]) {
    const invalid = decodeIssueTaskListQuery(input)
    assert.ok(Either.isLeft(invalid))
    assert.equal(invalid.left.code, "invalid_request")
  }
  for (const input of [
    { ...getInput, tasks: { page: { limit: 1, after: "bad" } } },
    { ...getInput, tasks: { page: { limit: 1 }, grant: "owner" } },
    { ...getInput, revision: 1 },
  ])
    assert.ok(Either.isLeft(decodeIssueTaskGetQuery(input)))
})

test("combined list rejects requested work above100 before any GitHub or SQLite call", async () => {
  let remoteCalls = 0
  let localCalls = 0
  const reader = createIssueTaskReader({
    github: createGitHubIssueReader({
      executeQuery: () =>
        Effect.sync(() => {
          remoteCalls += 1
          return listResponse([])
        }),
    }),
    tasks: {
      readManyTasks: () =>
        Effect.sync(() => {
          localCalls += 1
          return []
        }),
    },
  })
  const result = await run(
    Effect.either(
      reader.list({ ...listInput, page: { limit: 100 }, tasks: { limit: 2 } }),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_request")
  assert.equal(remoteCalls, 0)
  assert.equal(localCalls, 0)
})

test("combined list joins real GitHub decoding and SQLite pages in one ordered local batch", async () =>
  withStore(async store => {
    await run(seed(store))
    const calls: (readonly TaskReadQuery[])[] = []
    const reader = createIssueTaskReader({
      github: github(listResponse([2, 1])),
      tasks: {
        readManyTasks: queries => {
          calls.push(queries)
          return store.readManyTasks(queries)
        },
      },
    })
    const result = await run(reader.list(listInput))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], [
      { issue: issue(2), page: { limit: 1 }, filter: { status: "todo" } },
      { issue: issue(1), page: { limit: 1 }, filter: { status: "todo" } },
    ])
    assert.deepEqual(
      result.issues.map(row => row.metadata.issue.number),
      [2, 1],
    )
    assert.equal(result.issues[0]?.tasks, null)
    const saved = result.issues[1]?.tasks
    assert.ok(saved)
    assert.equal(saved.issue.number, 1)
    assert.equal(saved.tasks.length, 1)
    assert.ok(saved.next)
    assert.ok(
      Object.isFrozen(result) &&
        Object.isFrozen(result.issues) &&
        result.issues.every(Object.isFrozen),
    )
  }))

test("combined get retains real local filter/cursor/revision beside opaque remote body", async () =>
  withStore(async store => {
    await run(seed(store))
    const reader = createIssueTaskReader({
      github: github(getResponse),
      tasks: store,
    })
    const first = await run(reader.get(getInput))
    assert.equal(
      first.detail?.body,
      "Fixture requirement; /do-not-obey is opaque text",
    )
    assert.ok(first.tasks?.next)
    const second = await run(
      reader.get({
        ...getInput,
        tasks: { page: { limit: 1, after: first.tasks.next } },
      }),
    )
    assert.equal(second.tasks?.tasks.length, 1)
    assert.notEqual(first.tasks.tasks[0]?.id, second.tasks?.tasks[0]?.id)
    assert.equal(second.tasks?.revision, first.tasks.revision)
    const filtered = await run(
      reader.get({
        ...getInput,
        tasks: { page: { limit: 1 }, filter: { status: "done" } },
      }),
    )
    assert.ok(filtered.tasks)
    assert.deepEqual(filtered.tasks.tasks, [])
    assert.equal(filtered.tasks.revision, first.tasks.revision)
    assert.ok(Object.isFrozen(first))
  }))

test("combined get preserves existing local tasks when remote metadata is unavailable", async () =>
  withStore(async store => {
    await run(seed(store))
    const reader = createIssueTaskReader({
      github: github(JSON.stringify({ data: { repository: null } })),
      tasks: store,
    })
    const result = await run(reader.get(getInput))
    assert.deepEqual(result.issue, issue(1))
    assert.equal(result.detail, null)
    assert.equal(result.tasks?.tasks.length, 1)
  }))

test("combined empty issue list skips the local store without fabricating state", async () => {
  let calls = 0
  const reader = createIssueTaskReader({
    github: github(listResponse([])),
    tasks: {
      readManyTasks: () =>
        Effect.sync(() => {
          calls += 1
          return []
        }),
    },
  })
  const result = await run(reader.list(listInput))
  assert.deepEqual(result.issues, [])
  assert.equal(calls, 0)
})

test("combined list admits exactly100 qualified initial pages in a real local batch", async () =>
  withStore(async store => {
    const calls: (readonly TaskReadQuery[])[] = []
    const reader = createIssueTaskReader({
      github: github(
        listResponse(Array.from({ length: 100 }, (_, index) => index + 1)),
      ),
      tasks: {
        readManyTasks: queries => {
          calls.push(queries)
          return store.readManyTasks(queries)
        },
      },
    })
    const result = await run(
      reader.list({ ...listInput, page: { limit: 100 } }),
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.length, 100)
    assert.equal(result.issues.length, 100)
    assert.ok(result.issues.every(row => row.tasks === null))
  }))

test("combined get preserves missing local state without a fabricated revision", async () =>
  withStore(async store => {
    const reader = createIssueTaskReader({
      github: github(getResponse),
      tasks: store,
    })
    const result = await run(reader.get(getInput))
    assert.ok(result.detail)
    assert.equal(result.tasks, null)
    assert.deepEqual(result.issue, issue(1))
  }))

test("combined get leaves persisted cursor ownership validation to its qualified local read", async () =>
  withStore(async store => {
    await run(seed(store, 1))
    await run(seed(store, 2))
    const foreign = await run(
      store.readManyTasks([{ issue: issue(2), page: { limit: 1 } }]),
    )
    const cursor = foreign[0]?.page?.next
    assert.ok(cursor)
    const reader = createIssueTaskReader({
      github: github(getResponse),
      tasks: store,
    })
    const result = await run(
      Effect.either(
        reader.get({
          ...getInput,
          tasks: { page: { limit: 1, after: cursor } },
        }),
      ),
    )
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_input")
  }))

test("combined reads reject dropped/reordered/foreign local coverage and page-owner mismatch", async () =>
  withStore(async store => {
    await run(seed(store, 1))
    await run(seed(store, 2))
    const corruptions: readonly ((
      pages: readonly IssueTaskPageResult[],
    ) => readonly IssueTaskPageResult[])[] = [
      pages => pages.slice(0, 1),
      pages => [...pages].reverse(),
      pages =>
        pages.map((row, index) =>
          index === 0 ? { ...row, issue: issue(1, "example/foreign") } : row,
        ),
      pages =>
        pages.map((row, index) =>
          index === 0 && row.page !== null
            ? {
                ...row,
                page: { ...row.page, issue: issue(1, "example/foreign") },
              }
            : row,
        ),
    ]
    const outcomes: string[] = []
    for (const corrupt of corruptions) {
      const reader = createIssueTaskReader({
        github: github(listResponse()),
        tasks: {
          readManyTasks: queries =>
            store.readManyTasks(queries).pipe(Effect.map(corrupt)),
        },
      })
      const result = await run(Effect.either(reader.list(listInput)))
      outcomes.push(Either.isLeft(result) ? result.left.code : "success")
    }
    assert.deepEqual(
      outcomes,
      Array.from({ length: 4 }, () => "inconsistent_readback"),
    )
  }))

test("combined get requires exactly its requested qualified local page", async () =>
  withStore(async store => {
    await run(seed(store))
    const corruptions: readonly ((
      pages: readonly IssueTaskPageResult[],
    ) => readonly IssueTaskPageResult[])[] = [
      () => [],
      pages => [...pages, ...pages],
      pages =>
        pages.map(row => ({ ...row, issue: issue(1, "example/foreign") })),
      pages =>
        pages.map(row =>
          row.page === null
            ? row
            : {
                ...row,
                page: { ...row.page, issue: issue(1, "example/foreign") },
              },
        ),
    ]
    const outcomes: string[] = []
    for (const corrupt of corruptions) {
      const reader = createIssueTaskReader({
        github: github(getResponse),
        tasks: {
          readManyTasks: queries =>
            store.readManyTasks(queries).pipe(Effect.map(corrupt)),
        },
      })
      const result = await run(Effect.either(reader.get(getInput)))
      outcomes.push(Either.isLeft(result) ? result.left.code : "success")
    }
    assert.deepEqual(
      outcomes,
      Array.from({ length: 4 }, () => "inconsistent_readback"),
    )
  }))

test("combined remote failure never becomes a successful local-only view", async () => {
  let calls = 0
  const reader = createIssueTaskReader({
    github: createGitHubIssueReader({
      executeQuery: () =>
        Effect.fail(
          new GitHubReadError({
            code: "unavailable",
            message: "Private diagnostic",
          }),
        ),
    }),
    tasks: {
      readManyTasks: () =>
        Effect.sync(() => {
          calls += 1
          return []
        }),
    },
  })
  const result = await run(Effect.either(reader.list(listInput)))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "transport_error")
  assert.equal(calls, 0)
})

test("combined local failure preserves its typed error without returning incomplete metadata success", async () => {
  const failure = new TaskStoreError({
    code: "closed",
    message: "Fixture closed store",
  })
  const reader = createIssueTaskReader({
    github: github(listResponse()),
    tasks: { readManyTasks: () => Effect.fail(failure) },
  })
  const result = await run(Effect.either(reader.list(listInput)))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left, failure)
})

test("pre-aborted combined valid/invalid list/get requests perform no I/O", async () => {
  let calls = 0
  const reader = createIssueTaskReader({
    github: createGitHubIssueReader({
      executeQuery: () =>
        Effect.sync(() => {
          calls += 1
          return listResponse()
        }),
    }),
    tasks: {
      readManyTasks: () =>
        Effect.sync(() => {
          calls += 1
          return []
        }),
    },
  })
  const controller = new AbortController()
  controller.abort()
  const operations: readonly Effect.Effect<unknown, IssueTaskReadFailure>[] = [
    reader.list(listInput),
    reader.list({ ...listInput, tasks: { limit: 0 } }),
    reader.get(getInput),
    reader.get({ ...getInput, tasks: { page: { limit: 0 } } }),
  ]
  for (const operation of operations) {
    const result = await Effect.runPromiseExit(operation, {
      signal: controller.signal,
    })
    assert.ok(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause))
  }
  assert.equal(calls, 0)
})

test(
  "combined cancellation also propagates while awaiting the local projection",
  { timeout: 5_000 },
  async t =>
    withStore(async store => {
      const entered = await run(Deferred.make<void>())
      const controller = new AbortController()
      t.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      })
      let released = false
      const reader = createIssueTaskReader({
        github: github(getResponse),
        tasks: {
          readManyTasks: queries =>
            store.readManyTasks(queries).pipe(
              Effect.tap(() => Deferred.succeed(entered, undefined)),
              Effect.flatMap(() => Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  released = true
                }),
              ),
            ),
        },
      })
      const pending = Effect.runPromiseExit(reader.get(getInput), {
        signal: controller.signal,
      })
      try {
        assert.equal(
          await Promise.race([
            run(Deferred.await(entered)).then(() => true),
            pending.then(() => false),
          ]),
          true,
        )
        controller.abort()
        const result = await pending
        assert.ok(
          Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause),
        )
        assert.equal(released, true)
      } finally {
        controller.abort()
        await pending
      }
    }),
)

test(
  "in-flight combined cancellation interrupts remote work and does not begin local reads",
  { timeout: 5_000 },
  async t => {
    const entered = await run(Deferred.make<void>())
    const controller = new AbortController()
    t.signal.addEventListener("abort", () => controller.abort(), { once: true })
    let released = false
    let calls = 0
    const reader = createIssueTaskReader({
      github: createGitHubIssueReader({
        executeQuery: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                released = true
              }),
            ),
          ),
      }),
      tasks: {
        readManyTasks: () =>
          Effect.sync(() => {
            calls += 1
            return []
          }),
      },
    })
    const pending = Effect.runPromiseExit(reader.list(listInput), {
      signal: controller.signal,
    })
    try {
      assert.equal(
        await Promise.race([
          run(Deferred.await(entered)).then(() => true),
          pending.then(() => false),
        ]),
        true,
      )
      controller.abort()
      const result = await pending
      assert.ok(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause))
      assert.equal(released, true)
      assert.equal(calls, 0)
    } finally {
      controller.abort()
      await pending
    }
  },
)
