import assert from "node:assert/strict"
import test from "node:test"
import { Cause, Effect, Either, Exit } from "effect"
import { GitHubReadError, MAX_GITHUB_READ_BYTES } from "./github-read.ts"
import {
  createGitHubProjectReader,
  decodeGitHubProjectPage,
  decodeGitHubProjectQuery,
  GITHUB_PROJECT_SCHEDULING_DOCUMENT,
  type GitHubProjectQuery,
  type GitHubProjectQueryExecution,
  type GitHubSchedulingProject,
} from "./github-project-read.ts"

const bindings = {
  personal: {
    id: "PVT_kwHOAl_tIc4BpO1U",
    number: 4,
    owner: { __typename: "User", login: "0xgleb" },
    priority: "PVTF_lAHOAl_tIc4BpO1UzhnrZvE",
    effort: "PVTF_lAHOAl_tIc4BpO1UzhnrY5k",
    status: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
    inProgress: "In progress",
    priorityBacking: null,
    effortBacking: null,
  },
  dataclique: {
    id: "PVT_kwDOCA_DB84BkDqI",
    number: 12,
    owner: { __typename: "Organization", login: "dataclique" },
    priority: "PVTF_lADOCA_DB84BkDqIzhnrbUw",
    effort: "PVTF_lADOCA_DB84BkDqIzhny3PM",
    status: "PVTSSF_lADOCA_DB84BkDqIzhi1sHA",
    inProgress: "In Progress",
    priorityBacking: "IFN_kgDOAu5Mmg",
    effortBacking: "IFN_kgDOAu7REw",
  },
} as const

const field = (id: string, name: string, backing: string | null) => ({
  __typename: "ProjectV2Field",
  id,
  name,
  dataType: "NUMBER",
  isIssueField: backing !== null,
  issueField:
    backing === null ? null : { __typename: "IssueFieldNumber", id: backing },
})

const numeric = (
  project: GitHubSchedulingProject,
  id: string,
  value: number | null,
) =>
  project === "personal"
    ? {
        __typename: "ProjectV2ItemFieldNumberValue",
        field: { id },
        number: value,
      }
    : {
        __typename: "ProjectV2ItemIssueFieldValue",
        field: { id },
        issueFieldValue:
          value === null
            ? null
            : { __typename: "IssueFieldNumberValue", value },
      }

const viewer = { id: "fixture-viewer-id", login: "0xgleb" }
const unassigned = {
  nodes: [],
  totalCount: 0,
  pageInfo: { hasNextPage: false, endCursor: null },
}

const statusField = (project: GitHubSchedulingProject) => ({
  __typename: "ProjectV2SingleSelectField",
  id: bindings[project].status,
  name: "Status",
  dataType: "SINGLE_SELECT",
  options: [{ id: "47fc9ee4", name: bindings[project].inProgress }],
})

const issueItem = (
  project: GitHubSchedulingProject = "personal",
  patch: Readonly<Record<string, unknown>> = {},
) => ({
  id: "fixture-project-item",
  isArchived: false,
  content: {
    __typename: "Issue",
    id: "fixture-issue-node-id",
    number: 7,
    state: "OPEN",
    repository: { nameWithOwner: "Owner/Repository" },
    assignees: unassigned,
  },
  priority: numeric(project, bindings[project].priority, 2),
  effort: numeric(project, bindings[project].effort, 5),
  status: null,
  ...patch,
})

const envelope = (
  project: GitHubSchedulingProject = "personal",
  nodes: readonly unknown[] = [],
  patch: Readonly<Record<string, unknown>> = {},
) => {
  const binding = bindings[project]

  return {
    data: {
      viewer,
      node: {
        __typename: "ProjectV2",
        id: binding.id,
        number: binding.number,
        owner: binding.owner,
        priorityField: field(
          binding.priority,
          "Priority",
          binding.priorityBacking,
        ),
        effortField: field(binding.effort, "Effort", binding.effortBacking),
        statusField: statusField(project),
        items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        ...patch,
      },
    },
  }
}

const right = <A>(result: Either.Either<A, GitHubReadError>): A => {
  assert.ok(Either.isRight(result))
  return result.right
}

const code = <A>(result: Either.Either<A, GitHubReadError>) => {
  assert.ok(Either.isLeft(result))
  return result.left.code
}

const query = (
  project: GitHubSchedulingProject = "personal",
  limit = 10,
): GitHubProjectQuery => ({ project, page: { limit } })

const read = (
  payload: unknown,
  project: GitHubSchedulingProject = "personal",
) => decodeGitHubProjectPage(JSON.stringify(payload), query(project))

for (const project of ["personal", "dataclique"] as const) {
  test(`${project} carries authenticated actor, complete assignees and validated In Progress target`, () => {
    const assignees = [viewer, { id: "another-user", login: "levsgit" }]
    const row = issueItem(project)
    const page = right(
      read(
        envelope(project, [
          {
            ...row,
            content: {
              ...row.content,
              assignees: { ...unassigned, nodes: assignees, totalCount: 2 },
            },
          },
        ]),
        project,
      ),
    )
    const item = page.items[0]

    assert.deepEqual(Reflect.get(page, "viewer"), viewer)
    assert.deepEqual(Reflect.get(page, "inProgress"), {
      projectId: bindings[project].id,
      fieldId: bindings[project].status,
      optionId: "47fc9ee4",
    })
    assert.ok(item?.kind === "issue")
    assert.equal(Reflect.get(item, "issueNodeId"), "fixture-issue-node-id")
    assert.deepEqual(Reflect.get(item, "assignees"), assignees)
    assert.ok(Object.isFrozen(Reflect.get(page, "viewer")))
    assert.ok(Object.isFrozen(Reflect.get(item, "assignees")))
  })

  test(`${project} refuses missing/rebound/ambiguous In Progress metadata`, () => {
    const valid = statusField(project)
    for (const supplied of [
      null,
      { ...valid, id: "another-field" },
      { ...valid, name: "Another status" },
      { ...valid, __typename: "ProjectV2Field" },
      { ...valid, options: [] },
      {
        ...valid,
        options: [{ id: "other-option", name: bindings[project].inProgress }],
      },
      { ...valid, options: [{ id: "47fc9ee4", name: "Done" }] },
      { ...valid, options: [...valid.options, ...valid.options] },
    ]) {
      assert.ok(
        Either.isLeft(
          read(envelope(project, [], { statusField: supplied }), project),
        ),
      )
    }
  })
}

test("Project read cannot interpret unavailable or contradictory assignees as unassigned", () => {
  for (const assignees of [
    null,
    { ...unassigned, nodes: null },
    { ...unassigned, nodes: [null], totalCount: 1 },
    { ...unassigned, totalCount: 1 },
    { ...unassigned, nodes: [viewer], totalCount: 0 },
    { ...unassigned, nodes: [viewer, viewer], totalCount: 2 },
    {
      ...unassigned,
      nodes: [viewer],
      totalCount: 1,
      pageInfo: { hasNextPage: true, endCursor: "more" },
    },
    { ...unassigned, totalCount: -1 },
    { ...unassigned, nodes: [{ id: "", login: "0xgleb" }], totalCount: 1 },
    { ...unassigned, nodes: [{ id: "user", login: "" }], totalCount: 1 },
  ]) {
    const row = issueItem()
    assert.ok(
      Either.isLeft(
        read(
          envelope("personal", [
            {
              ...row,
              content: { ...row.content, assignees },
            },
          ]),
        ),
      ),
    )
  }
})

test("Project read requires actual viewer evidence rather than assuming the configured project owner", () => {
  for (const actor of [
    undefined,
    null,
    { id: "", login: "0xgleb" },
    { id: "viewer", login: "" },
  ]) {
    const payload = envelope()
    assert.ok(
      Either.isLeft(
        read({ ...payload, data: { ...payload.data, viewer: actor } }),
      ),
    )
  }
})

test("Project observations retain a validated current Status and available option metadata", () => {
  const page = right(
    read(
      envelope("personal", [
        issueItem("personal", {
          status: {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            field: { id: bindings.personal.status },
            optionId: "47fc9ee4",
          },
        }),
      ]),
    ),
  )
  const row = page.items[0]
  assert.ok(row?.kind === "issue")
  assert.equal(Reflect.get(row, "status"), "47fc9ee4")
  assert.deepEqual(
    Reflect.get(page, "statusOptions"),
    statusField("personal").options,
  )
})

test("current Project Status cannot silently use another field, unknown option or missing evidence", () => {
  for (const status of [
    undefined,
    {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      field: { id: "wrong-field" },
      optionId: "47fc9ee4",
    },
    {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      field: { id: bindings.personal.status },
      optionId: "unknown-option",
    },
    {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      field: { id: bindings.personal.status },
      optionId: null,
    },
  ])
    assert.ok(
      Either.isLeft(
        read(envelope("personal", [issueItem("personal", { status })])),
      ),
    )
})

test("Project queries detach and freeze only selected scope and bounded opaque pagination", () => {
  const input = {
    project: "personal",
    page: { limit: 2, after: " cursor\u0000 " },
  }
  const normalized = right(decodeGitHubProjectQuery(input))

  input.page.limit = 10
  assert.deepEqual(normalized, {
    project: "personal",
    page: { limit: 2, after: " cursor\u0000 " },
  })
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.page))
  assert.notEqual(normalized.page, input.page)
  assert.equal(
    right(
      decodeGitHubProjectQuery({ project: "dataclique", page: { limit: 100 } }),
    ).page.limit,
    100,
  )
})

test("Project queries reject caller authority, arbitrary targets and malformed budgets", () => {
  for (const input of [
    null,
    [],
    { project: "other", page: { limit: 1 } },
    { project: "personal", page: { limit: 0 } },
    { project: "personal", page: { limit: 101 } },
    { project: "personal", page: { limit: 1.5 } },
    { project: "personal", page: { limit: 1, after: "" } },
    { project: "personal", page: { limit: 1, after: "x".repeat(4097) } },
    { project: "personal", page: { limit: 1 }, authority: true },
    { project: "personal", page: { limit: 1, revision: 2 } },
    { project: "personal", page: { limit: 1 }, document: "mutation{}" },
  ]) {
    assert.equal(code(decodeGitHubProjectQuery(input)), "invalid_request")
  }
})

for (const project of ["personal", "dataclique"] as const) {
  test(`${project} Project accepts verified binding and qualified issue numeric variants`, () => {
    const page = right(read(envelope(project, [issueItem(project)]), project))
    const item = page.items[0]

    assert.equal(page.project, project)
    assert.ok(item?.kind === "issue")
    assert.deepEqual(item.issue, { repository: "owner/repository", number: 7 })
    assert.deepEqual(item.priority, { kind: "number", value: 2 })
    assert.deepEqual(item.effort, { kind: "number", value: 5 })
    assert.ok(Object.isFrozen(page))
    assert.ok(Object.isFrozen(page.items))
    assert.ok(Object.isFrozen(page.pageInfo))
    assert.ok(Object.isFrozen(item))
    assert.ok(Object.isFrozen(item.issue))
    assert.ok(Object.isFrozen(item.priority))
  })

  test(`${project} Project preserves unset versus finite numeric data without eligibility policy`, () => {
    const missing = right(
      read(
        envelope(project, [
          issueItem(project, {
            priority: null,
            effort: numeric(project, bindings[project].effort, null),
          }),
        ]),
        project,
      ),
    ).items[0]

    assert.ok(missing?.kind === "issue")
    assert.deepEqual(missing.priority, { kind: "unset" })
    assert.deepEqual(missing.effort, { kind: "unset" })

    for (const value of [0, -1, 0.5, 1e100]) {
      const item = right(
        read(
          envelope(project, [
            issueItem(project, {
              priority: numeric(project, bindings[project].priority, value),
            }),
          ]),
          project,
        ),
      ).items[0]

      assert.ok(item?.kind === "issue")
      assert.deepEqual(item.priority, { kind: "number", value })
    }
  })
}

test("Project binding mismatches cannot silently rebind a configured field or owner", () => {
  for (const patch of [
    { id: "different-project" },
    { number: 99 },
    { owner: { __typename: "User", login: "other" } },
    { priorityField: field("other-field", "Priority", null) },
    {
      priorityField: {
        ...field(bindings.personal.priority, "Priority", null),
        dataType: "TEXT",
      },
    },
    { effortField: field(bindings.personal.effort, "Renamed", null) },
    { effortField: field(bindings.personal.effort, "Effort", "other-backing") },
  ]) {
    assert.equal(
      code(read(envelope("personal", [], patch))),
      "invalid_response",
    )
  }
  assert.equal(
    code(
      read(
        envelope("dataclique", [], {
          effortField: field(
            bindings.dataclique.effort,
            "Effort",
            "wrong-number-field",
          ),
        }),
        "dataclique",
      ),
    ),
    "invalid_response",
  )
})

test("Project values reject wrong field identities, nonnumbers and incompatible selected variants", () => {
  for (const priority of [
    numeric("personal", "other-field", 1),
    {
      __typename: "ProjectV2ItemFieldNumberValue",
      field: { id: bindings.personal.priority },
      number: "1",
    },
    {
      __typename: "ProjectV2ItemFieldTextValue",
      field: { id: bindings.personal.priority },
      text: "1",
    },
  ]) {
    assert.equal(
      code(read(envelope("personal", [issueItem("personal", { priority })]))),
      "invalid_response",
    )
  }
  assert.equal(
    code(
      read(
        envelope("dataclique", [
          issueItem("dataclique", {
            effort: {
              __typename: "ProjectV2ItemIssueFieldValue",
              field: { id: bindings.dataclique.effort },
              issueFieldValue: {
                __typename: "IssueFieldTextValue",
                value: "5",
              },
            },
          }),
        ]),
        "dataclique",
      ),
    ),
    "invalid_response",
  )
  const finite = JSON.stringify(envelope("personal", [issueItem()]))
  assert.equal(
    code(
      decodeGitHubProjectPage(
        finite.replace('"number":2', '"number":1e400'),
        query(),
      ),
    ),
    "invalid_response",
  )
})

test("Project read distinguishes unavailable, partial and malformed content instead of empty success", () => {
  assert.equal(code(read({ data: { viewer, node: null } })), "unavailable")
  assert.equal(
    code(read(envelope("personal", [], { priorityField: null }))),
    "unavailable",
  )
  assert.equal(
    code(
      read(
        envelope("personal", [], {
          items: {
            nodes: null,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      ),
    ),
    "partial_response",
  )
  assert.equal(code(read(envelope("personal", [null]))), "partial_response")
  assert.equal(
    code(
      read(envelope("personal", [issueItem("personal", { content: null })])),
    ),
    "partial_response",
  )
  assert.equal(
    code(
      read(
        envelope("personal", [
          issueItem("personal", { content: { __typename: "Unknown" } }),
        ]),
      ),
    ),
    "invalid_response",
  )
  const empty = right(read(envelope()))
  assert.deepEqual(empty.items, [])
})

test("Project read preserves known nonissues without inventing issue references", () => {
  const page = right(
    read(
      envelope("personal", [
        {
          id: "pr-item",
          isArchived: false,
          content: { __typename: "PullRequest" },
          priority: null,
          effort: null,
        },
        {
          id: "draft-item",
          isArchived: false,
          content: { __typename: "DraftIssue" },
          priority: null,
          effort: null,
        },
      ]),
    ),
  )

  assert.deepEqual(
    page.items.map(item =>
      item.kind === "other" ? item.contentType : item.kind,
    ),
    ["PullRequest", "DraftIssue"],
  )
  assert.ok(page.items.every(item => Object.isFrozen(item)))
})

test("Project response admits 100 complete distinct items at the upper row bound", () => {
  const original = issueItem()
  const nodes = Array.from({ length: 100 }, (_, index) =>
    issueItem("personal", {
      id: `item-${index}`,
      content: { ...original.content, number: index + 1 },
    }),
  )
  const page = right(
    decodeGitHubProjectPage(
      JSON.stringify(envelope("personal", nodes)),
      query("personal", 100),
    ),
  )

  assert.deepEqual(
    page.items.map(item => {
      assert.ok(item.kind === "issue")
      return { itemId: item.itemId, issue: item.issue }
    }),
    Array.from({ length: 100 }, (_, index) => ({
      itemId: `item-${index}`,
      issue: { repository: "owner/repository", number: index + 1 },
    })),
  )
})

test("Project issues preserve closed state without applying eligibility policy", () => {
  const open = issueItem()
  const closed = issueItem("personal", {
    content: { ...open.content, state: "CLOSED" },
  })
  const item = right(read(envelope("personal", [closed]))).items[0]

  assert.ok(item?.kind === "issue")
  assert.equal(item.state, "closed")
  assert.deepEqual(item.priority, { kind: "number", value: 2 })
  assert.deepEqual(item.effort, { kind: "number", value: 5 })
  assert.equal(
    code(
      read(
        envelope("personal", [
          issueItem("personal", {
            content: { ...open.content, state: "UNKNOWN" },
          }),
        ]),
      ),
    ),
    "invalid_response",
  )
})

test("Project duplicate-item detection is independent of qualified issue uniqueness", () => {
  const first = issueItem()
  const second = issueItem("personal", {
    id: "second-item",
    content: { ...first.content, number: 8 },
  })

  assert.equal(
    right(read(envelope("personal", [first, second]))).items.length,
    2,
  )
  assert.equal(
    code(read(envelope("personal", [first, { ...second, id: first.id }]))),
    "invalid_response",
  )
})

test("Project rows enforce qualified identities, active-only scope, uniqueness and requested row budget", () => {
  for (const item of [
    issueItem("personal", { isArchived: true }),
    issueItem("personal", { id: "" }),
    issueItem("personal", {
      content: {
        __typename: "Issue",
        number: 0,
        state: "OPEN",
        repository: { nameWithOwner: "owner/repo" },
      },
    }),
    issueItem("personal", {
      content: {
        __typename: "Issue",
        number: 1,
        state: "OPEN",
        repository: { nameWithOwner: "bad" },
      },
    }),
  ])
    assert.equal(code(read(envelope("personal", [item]))), "invalid_response")

  assert.equal(
    code(read(envelope("personal", [issueItem(), issueItem()]))),
    "invalid_response",
  )
  assert.equal(
    code(
      read(
        envelope("personal", [
          issueItem(),
          issueItem("personal", { id: "other-item" }),
        ]),
      ),
    ),
    "invalid_response",
  )
  assert.equal(
    code(
      decodeGitHubProjectPage(
        JSON.stringify(
          envelope("personal", [
            issueItem(),
            issueItem("personal", {
              id: "second",
              content: { __typename: "DraftIssue" },
            }),
          ]),
        ),
        query("personal", 1),
      ),
    ),
    "invalid_response",
  )
})

test("Project cursors distinguish final cursors from missing or nonadvancing continuation", () => {
  const supplied = right(
    decodeGitHubProjectQuery({
      project: "personal",
      page: { limit: 1, after: "before" },
    }),
  )
  
  const payload = (pageInfo: unknown) =>
    JSON.stringify(envelope("personal", [], { items: { nodes: [], pageInfo } }))

  for (const endCursor of [null, "last"]) {
    assert.deepEqual(
      right(
        decodeGitHubProjectPage(
          payload({ hasNextPage: false, endCursor }),
          supplied,
        ),
      ).pageInfo,
      { hasNextPage: false, endCursor },
    )
  }
  
  for (const endCursor of [null, "", "before"]) {
    assert.equal(
      code(
        decodeGitHubProjectPage(
          payload({ hasNextPage: true, endCursor }),
          supplied,
        ),
      ),
      "invalid_response",
    )
  }
  
  assert.deepEqual(
    right(
      decodeGitHubProjectPage(
        payload({ hasNextPage: true, endCursor: " next " }),
        supplied,
      ),
    ).pageInfo,
    { hasNextPage: true, endCursor: " next " },
  )
})

test("every continuing Project cursor is usable within the request byte budget", () => {
  const payload = (endCursor: string) =>
    JSON.stringify(
      envelope("personal", [], {
        items: { nodes: [], pageInfo: { hasNextPage: true, endCursor } },
      }),
    )

  for (const endCursor of ["x".repeat(4096), "😀".repeat(1024)]) {
    const page = right(decodeGitHubProjectPage(payload(endCursor), query()))
    const next = decodeGitHubProjectQuery({
      project: "personal",
      page: { limit: 1, after: page.pageInfo.endCursor },
    })

    assert.deepEqual(page.pageInfo, { hasNextPage: true, endCursor })
    assert.equal(right(next).page.after, endCursor)
  }
  
  for (const endCursor of ["x".repeat(4097), "😀".repeat(1024) + "x"]) {
    assert.equal(
      code(decodeGitHubProjectPage(payload(endCursor), query())),
      "invalid_response",
    )
  }
})

test("Project response enforces byte budget before JSON and never accepts partial GraphQL errors", () => {
  const body = JSON.stringify(envelope())
  const exact =
    body + " ".repeat(MAX_GITHUB_READ_BYTES - Buffer.byteLength(body))

  assert.ok(Either.isRight(decodeGitHubProjectPage(exact, query())))
  assert.equal(code(decodeGitHubProjectPage(exact + "😀", query())), "capacity")
  assert.equal(
    code(
      decodeGitHubProjectPage("{".repeat(MAX_GITHUB_READ_BYTES + 1), query()),
    ),
    "capacity",
  )
  
  const error = read({
    ...envelope(),
    errors: [{ message: "fake-private-provider-detail" }],
  })

  assert.equal(code(error), "remote_error")
  assert.ok(Either.isLeft(error))
  assert.doesNotMatch(error.left.message, /fake-private/)
  assert.equal(code(read({ ...envelope(), errors: [] })), "invalid_response")
})

test("Project host read sends one frozen fixed query and snapshots its callback", async () => {
  let observed: GitHubProjectQueryExecution | undefined
  const options = {
    executeQuery: (
      request: GitHubProjectQueryExecution,
    ): Effect.Effect<string, GitHubReadError> =>
      Effect.sync(() => {
        observed = request
        return JSON.stringify(envelope("dataclique", [issueItem("dataclique")]))
      }),
  }
  const reader = createGitHubProjectReader(options)
  options.executeQuery = () => Effect.die("callback replaced")
  const page = await Effect.runPromise(
    reader.read({ project: "dataclique", page: { limit: 2, after: "opaque" } }),
  )

  assert.equal(page.items.length, 1)
  assert.ok(observed)
  assert.equal(observed.document, GITHUB_PROJECT_SCHEDULING_DOCUMENT)
  assert.match(observed.document, /^query /u)
  assert.match(observed.document, /archivedStates: \[NOT_ARCHIVED\]/u)
  assert.doesNotMatch(
    observed.document,
    /\b(?:mutation|body|title|comments)\b/u,
  )
  assert.deepEqual(observed.variables, {
    project: bindings.dataclique.id,
    first: 2,
    after: "opaque",
  })
  assert.ok(Object.isFrozen(observed))
  assert.ok(Object.isFrozen(observed.variables))
})

test("Project host read rejects invalid requests and pre-abort without I/O", async () => {
  let calls = 0
  const reader = createGitHubProjectReader({
    executeQuery: () =>
      Effect.sync(() => {
        calls++
        return JSON.stringify(envelope())
      }),
  })
  const invalid = await Effect.runPromise(
    Effect.either(reader.read({ project: "other", page: { limit: 1 } })),
  )

  assert.equal(code(invalid), "invalid_request")
  assert.equal(calls, 0)
  const controller = new AbortController()
  controller.abort()
  const exit = await Effect.runPromiseExit(
    reader.read({ project: "personal", page: { limit: 1 } }),
    { signal: controller.signal },
  )

  assert.ok(Exit.isFailure(exit))
  assert.ok(Cause.isInterrupted(exit.cause))
  assert.equal(calls, 0)
})

test("Project host failure and defect are sanitized while interruption stays interruption", async () => {
  for (const failure of [
    Effect.fail(
      new GitHubReadError({
        code: "remote_error",
        message: "fake-private-provider-detail",
      }),
    ),
    Effect.die("fake-private-provider-detail"),
  ]) {
    const reader = createGitHubProjectReader({ executeQuery: () => failure })
    const result = await Effect.runPromise(
      Effect.either(reader.read({ project: "personal", page: { limit: 1 } })),
    )

    assert.equal(code(result), "transport_error")
    assert.ok(Either.isLeft(result))
    assert.doesNotMatch(result.left.message, /fake-private/)
  }
  const reader = createGitHubProjectReader({
    executeQuery: () => Effect.interrupt,
  })
  const exit = await Effect.runPromiseExit(
    reader.read({ project: "personal", page: { limit: 1 } }),
  )

  assert.ok(Exit.isFailure(exit))
  assert.ok(Cause.isInterrupted(exit.cause))
})
