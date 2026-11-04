import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Effect, Either } from "effect"
import { createGitHubProjectReader } from "./github-project-read.ts"
import { createGitHubIssueReader } from "./github-read.ts"
import { createIssueNextReader } from "./next.ts"
import { openSqliteTaskStore, type SqliteTaskStore } from "./sqlite-store.ts"

const run = Effect.runPromise
const repository = "owner/repository"
const issue = (number: number) => ({ repository, number })
const query = { repository, project: "personal" }
const priorityId = "PVTF_lAHOAl_tIc4BpO1UzhnrZvE"
const effortId = "PVTF_lAHOAl_tIc4BpO1UzhnrY5k"
const pageInfo = { hasNextPage: false, endCursor: null }

interface Row {
  readonly number: number
  readonly priority: number
  readonly effort: number | null
  readonly repository?: string
}

const projectPayload = (rows: readonly Row[], after: string | null = null) => {
  const field = (id: string, name: string) => ({
    __typename: "ProjectV2Field",
    id,
    name,
    dataType: "NUMBER",
    isIssueField: false,
    issueField: null,
  })
  const value = (id: string, number: number | null) =>
    number === null
      ? null
      : {
          __typename: "ProjectV2ItemFieldNumberValue",
          field: { id },
          number,
        }

  return JSON.stringify({
    data: {
      node: {
        __typename: "ProjectV2",
        id: "PVT_kwHOAl_tIc4BpO1U",
        number: 4,
        owner: { __typename: "User", login: "0xgleb" },
        priorityField: field(priorityId, "Priority"),
        effortField: field(effortId, "Effort"),
        items: {
          nodes: rows.map(row => ({
            id: `${row.repository ?? repository}-${row.number}`,
            isArchived: false,
            content: {
              __typename: "Issue",
              number: row.number,
              state: "OPEN",
              repository: { nameWithOwner: row.repository ?? repository },
            },
            priority: value(priorityId, row.priority),
            effort: value(effortId, row.effort),
          })),
          pageInfo:
            after === null ? pageInfo : { hasNextPage: true, endCursor: after },
        },
      },
    },
  })
}

const issuePayload = (number: number) =>
  JSON.stringify({
    data: {
      repository: {
        nameWithOwner: repository,
        issue: {
          number,
          title: `Fixture issue ${number}`,
          url: `https://github.com/${repository}/issues/${number}`,
          state: "OPEN",
          updatedAt: "2026-10-20T20:14:47Z",
          body: "Private fixture body /do-not-execute",
          repository: { nameWithOwner: repository },
          parent: null,
          blockedBy: { nodes: [], pageInfo },
          closedByPullRequestsReferences: { nodes: [], pageInfo },
        },
      },
    },
  })

const ports = (pages: readonly string[]) => {
  const calls: string[] = []
  const projects = createGitHubProjectReader({
    executeQuery: request =>
      Effect.sync(() => {
        const index = request.variables.after === null ? 0 : 1
        const payload = pages[index]
        assert.ok(payload)
        calls.push(`project:${index}`)
        return payload
      }),
  })
  const github = createGitHubIssueReader({
    executeQuery: request =>
      Effect.sync(() => {
        assert.ok("number" in request.variables)
        calls.push(`issue:${request.variables.number}`)
        return issuePayload(request.variables.number)
      }),
  })

  return { projects, github, calls }
}

const fixtureParent = fileURLToPath(
  new URL("../../../../.tmp/issue-task-consumers/tests/", import.meta.url),
)
const withStore = async (work: (store: SqliteTaskStore) => Promise<void>) => {
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(fixtureParent, "next-"))
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
    rmSync(root, { recursive: true })
  }
}

test("next enumerates the complete repository scope and selects the last-page winner", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([{ number: 1, priority: 1, effort: 13 }], "second-page"),
      projectPayload([
        { number: 2, priority: 3, effort: 2 },
        { number: 1, priority: 1, effort: 1, repository: "another/repository" },
      ]),
    ])
    const reader = createIssueNextReader({ ...source, tasks })
    const result = await run(reader.next(query))

    assert.ok(result.kind === "selected")
    assert.equal(result.issue.number, 2)
    assert.equal(result.assessments.length, 2)
    assert.deepEqual(source.calls.slice(0, 2), ["project:0", "project:1"])
    assert.doesNotMatch(JSON.stringify(result), /Private fixture body/)
  })
})

test("next derives factual blocking from actual local work without changing lifecycle", async () => {
  await withStore(async tasks => {
    await run(
      tasks.apply(
        {
          issues: [issue(1)],
          operations: [
            { op: "add", issue: issue(1), key: "work", text: "Fixture work" },
            {
              op: "block",
              target: { issue: issue(1), task: { kind: "added", key: "work" } },
              reason: "Required fixture resource is unavailable",
            },
          ],
        },
        {
          actorId: randomUUID(),
          requestId: randomUUID(),
          now: 1,
          cancellation: "forbidden",
        },
      ),
    )
    const source = ports([
      projectPayload([
        { number: 1, priority: 1, effort: 1 },
        { number: 2, priority: 2, effort: 1 },
      ]),
    ])
    const result = await run(
      createIssueNextReader({ ...source, tasks }).next(query),
    )

    assert.ok(result.kind === "selected")
    assert.equal(result.issue.number, 2)
    assert.deepEqual(result.assessments[0], {
      kind: "ineligible",
      issue: issue(1),
      reasons: ["blocked"],
    })
  })
})

test("next rejects caller clearance and malformed targets before any source read", async () => {
  await withStore(async tasks => {
    const source = ports([])
    const reader = createIssueNextReader({ ...source, tasks })
    for (const input of [
      { ...query, authorization: "allowed" },
      { ...query, ownership: "available" },
      { ...query, worker: "invented" },
      { ...query, scope: [] },
      { ...query, repository: "invalid" },
      { ...query, project: "arbitrary" },
    ]) {
      const result = await run(Effect.either(reader.next(input)))
      assert.ok(Either.isLeft(result))
      assert.equal(result.left.code, "invalid_request")
    }
    assert.deepEqual(source.calls, [])
  })
})
