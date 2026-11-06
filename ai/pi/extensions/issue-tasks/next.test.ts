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
const viewer = { id: "fixture-viewer-id", login: "0xgleb" }

interface Row {
  readonly number: number
  readonly priority: number
  readonly effort: number | null
  readonly repository?: string
  readonly status?: string | null
  readonly assignees?: readonly {
    readonly id: string
    readonly login: string
  }[]
}

const projectPayload = (
  rows: readonly Row[],
  after: string | null = null,
  actor = viewer,
) => {
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
      viewer: actor,
      node: {
        __typename: "ProjectV2",
        id: "PVT_kwHOAl_tIc4BpO1U",
        number: 4,
        owner: { __typename: "User", login: "0xgleb" },
        priorityField: field(priorityId, "Priority"),
        effortField: field(effortId, "Effort"),
        statusField: {
          __typename: "ProjectV2SingleSelectField",
          id: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
          name: "Status",
          dataType: "SINGLE_SELECT",
          options: [
            { id: "47fc9ee4", name: "In progress" },
            { id: "aba860b9", name: "In review" },
            { id: "refine-option", name: "Refine" },
          ],
        },
        items: {
          nodes: rows.map(row => ({
            id: `${row.repository ?? repository}-${row.number}`,
            isArchived: false,
            content: {
              __typename: "Issue",
              id: `${row.repository ?? repository}-issue-${row.number}`,
              assignees: {
                nodes: row.assignees ?? [],
                totalCount: row.assignees?.length ?? 0,
                pageInfo,
              },
              number: row.number,
              state: "OPEN",
              repository: { nameWithOwner: row.repository ?? repository },
            },
            priority: value(priorityId, row.priority),
            effort: value(effortId, row.effort),
            status:
              row.status === undefined || row.status === null
                ? null
                : {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    optionId: row.status,
                    field: { id: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs" },
                  },
          })),
          pageInfo:
            after === null ? pageInfo : { hasNextPage: true, endCursor: after },
        },
      },
    },
  })
}

const issuePayload = (
  number: number,
  blocking: readonly number[] = [],
  state: "OPEN" | "CLOSED" = "OPEN",
) =>
  JSON.stringify({
    data: {
      repository: {
        nameWithOwner: repository,
        issue: {
          number,
          title: `Fixture issue ${number}`,
          url: `https://github.com/${repository}/issues/${number}`,
          state,
          updatedAt: "2026-10-20T20:14:47Z",
          body: "Private fixture body /do-not-execute",
          repository: { nameWithOwner: repository },
          parent: null,
          blockedBy: {
            nodes: blocking.map(number => ({
              number,
              url: `https://github.com/${repository}/issues/${number}`,
              repository: { nameWithOwner: repository },
            })),
            pageInfo,
          },
          closedByPullRequestsReferences: { nodes: [], pageInfo },
        },
      },
    },
  })

const ports = (
  pages: readonly string[],
  metadata: (number: number) => string = number => issuePayload(number),
) => {
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
        return metadata(request.variables.number)
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

test("implementation next excludes actual Refine status before ranking even with complete numeric metadata", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([
        { number: 1, priority: 1, effort: 1, status: "refine-option" },
        { number: 2, priority: 2, effort: 1, status: "47fc9ee4" },
      ]),
    ])
    const result = await run(
      createIssueNextReader({ ...source, tasks }).next(query),
    )
    assert.ok(result.kind === "selected")
    assert.equal(result.issue.number, 2)
    assert.ok(
      !source.calls.includes("issue:1"),
      "Refine exclusion must precede dependency/task reads",
    )
  })
})

test("reviewer next selects only In review issues and preserves an implementation author's assignment", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([
        { number: 1, priority: 1, effort: 1, status: "47fc9ee4" },
        {
          number: 2,
          priority: 2,
          effort: 1,
          status: "aba860b9",
          assignees: [{ id: "other-user", login: "levsgit" }],
        },
      ]),
    ])
    const observed = await run(
      createIssueNextReader({ ...source, tasks }).read({
        ...query,
        mode: "review",
      }),
    )
    assert.ok(observed.selection.kind === "selected")
    assert.equal(observed.selection.issue.number, 2)
    assert.equal(observed.selected?.assignees[0]?.login, "levsgit")
    assert.equal(observed.review?.status.optionId, "aba860b9")
    assert.ok(
      !source.calls.includes("issue:1"),
      "non-review issues must be excluded before downstream reads",
    )
  })
})

test("reviewer next returns none if no issue has the actual In review status", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([
        { number: 1, priority: 1, effort: 1, status: "47fc9ee4" },
      ]),
    ])
    const observed = await run(
      createIssueNextReader({ ...source, tasks }).read({
        ...query,
        mode: "review",
      }),
    )
    assert.equal(observed.selection.kind, "none")
    assert.deepEqual(source.calls, ["project:0"])
  })
})

for (const assignees of [
  [{ id: "other-user", login: "levsgit" }],
  [viewer, { id: "other-user", login: "levsgit" }],
]) {
  test(`next excludes another assignee before downstream reads: ${assignees.map(user => user.login).join(",")}`, async () => {
    await withStore(async tasks => {
      const source = ports([
        projectPayload([
          { number: 1, priority: 1, effort: 1, assignees },
          { number: 2, priority: 2, effort: 1 },
        ]),
      ])
      const result = await run(
        createIssueNextReader({ ...source, tasks }).next(query),
      )
      assert.ok(result.kind === "selected")
      assert.equal(result.issue.number, 2)
      assert.ok(!source.calls.includes("issue:1"))
    })
  })
}

test("next admits viewer-only assignment without changing numeric ranking", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([
        { number: 1, priority: 1, effort: 1, assignees: [viewer] },
        { number: 2, priority: 2, effort: 1 },
      ]),
    ])
    const result = await run(
      createIssueNextReader({ ...source, tasks }).next(query),
    )
    assert.ok(result.kind === "selected")
    assert.equal(result.issue.number, 1)
  })
})

test("next rejects a changed authenticated actor between Project pages", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([{ number: 1, priority: 1, effort: 1 }], "second-page"),
      projectPayload([{ number: 2, priority: 2, effort: 1 }], null, {
        id: "changed-viewer",
        login: "another",
      }),
    ])
    const result = await run(
      Effect.either(createIssueNextReader({ ...source, tasks }).next(query)),
    )
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "inconsistent_readback")
    assert.ok(!source.calls.some(call => call.startsWith("issue:")))
  })
})

test("selection observation retains the exact chosen target and factual ownership exclusions", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([
        {
          number: 1,
          priority: 1,
          effort: 1,
          assignees: [{ id: "other-user", login: "levsgit" }],
        },
        { number: 2, priority: 2, effort: 1 },
      ]),
    ])
    const observed = await run(
      createIssueNextReader({ ...source, tasks }).read(query),
    )
    assert.equal(observed.selection.kind, "selected")
    assert.equal(observed.selected?.issue.number, 2)
    assert.equal(observed.selected?.issueNodeId, "owner/repository-issue-2")
    assert.equal(observed.selected?.itemId, "owner/repository-2")
    assert.deepEqual(observed.viewer, viewer)
    assert.deepEqual(observed.inProgress, {
      projectId: "PVT_kwHOAl_tIc4BpO1U",
      fieldId: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
      optionId: "47fc9ee4",
    })
    assert.deepEqual(
      observed.excludedAssignments.map(row => row.issue),
      [issue(1)],
    )
    assert.ok(Object.isFrozen(observed))
    assert.ok(Object.isFrozen(observed.viewer))
    assert.ok(Object.isFrozen(observed.selected))
    assert.ok(Object.isFrozen(observed.excludedAssignments))
  })
})

test("all other-assigned issues produce no recommendation without downstream reads", async () => {
  await withStore(async tasks => {
    const source = ports([
      projectPayload([
        {
          number: 1,
          priority: 1,
          effort: 1,
          assignees: [{ id: "other-user", login: "levsgit" }],
        },
      ]),
    ])
    const observed = await run(
      createIssueNextReader({ ...source, tasks }).read(query),
    )
    assert.equal(observed.selection.kind, "none")
    assert.equal(observed.selected, null)
    assert.equal(observed.excludedAssignments.length, 1)
    assert.deepEqual(source.calls, ["project:0"])
  })
})

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

for (const blockerState of ["OPEN", "CLOSED"] as const) {
  test(`native next treats #515 blocked by #412 (${blockerState}) before Priority 12 × Effort 1`, async () => {
    await withStore(async tasks => {
      const source = ports(
        [
          projectPayload([
            { number: 515, priority: 12, effort: 1 },
            { number: 516, priority: 13, effort: 1 },
          ]),
        ],
        number =>
          issuePayload(
            number,
            number === 515 ? [412] : [],
            number === 412 ? blockerState : "OPEN",
          ),
      )
      const result = await run(
        createIssueNextReader({ ...source, tasks }).next(query),
      )
      assert.ok(result.kind === "selected")
      assert.equal(result.issue.number, blockerState === "OPEN" ? 516 : 515)
      assert.ok(
        source.calls.includes("issue:412"),
        "must resolve the actual blocker state",
      )
      const assessment = result.assessments.find(
        row => row.issue.number === 515,
      )
      if (blockerState === "OPEN") {
        assert.deepEqual(assessment, {
          kind: "ineligible",
          issue: issue(515),
          reasons: ["blocked_dependencies"],
        })
      } else assert.equal(assessment?.kind, "eligible")
    })
  })
}

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
