import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { decodeIssueReference, decodeIssueRepository } from "./identity.ts"
import {
  decodeGitHubIssueListQuery,
  decodeGitHubIssueListPage,
  MAX_GITHUB_READ_BYTES,
  type GitHubIssueListQuery,
  type GitHubReadError,
} from "./github-read.ts"

const repository = decodeIssueRepository("0xgleb/dotconfig")
assert.ok(Either.isRight(repository))
const query: GitHubIssueListQuery = {
  repository: repository.right,
  state: "open",
  page: { limit: 1 },
}
const cursor = "Y3Vyc29yOnYyOpK0MjAyNi0wMy0xOFQxOToxNTowMFrO9Daxdg=="
// Selected fields from the verified read-only GitHub response; no body or comments.
const recorded = {
  data: {
    repository: {
      nameWithOwner: "0xgleb/dotconfig",
      issues: {
        nodes: [
          {
            number: 19,
            title: "add avante.nvim plugin",
            url: "https://github.com/0xgleb/dotconfig/issues/19",
            state: "OPEN",
            updatedAt: "2026-03-18T19:15:00Z",
            repository: { nameWithOwner: "0xgleb/dotconfig" },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: cursor },
      },
    },
  },
}
const failure = (
  payload: unknown,
  code: GitHubReadError["code"],
  input = query,
) => {
  const decoded = decodeGitHubIssueListPage(payload, input)
  assert.ok(Either.isLeft(decoded))
  assert.equal(decoded.left.code, code)
}

test("GitHub issue list queries require explicit canonical scope and detached pagination", () => {
  const source = {
    repository: "0xGleb/DotConfig",
    state: "open",
    page: { limit: 1, after: cursor },
  }
  const decoded = decodeGitHubIssueListQuery(source)

  assert.ok(Either.isRight(decoded))
  assert.deepEqual(decoded.right, {
    ...query,
    page: { limit: 1, after: cursor },
  })
  source.page.limit = 2
  source.repository = "other/repo"
  assert.deepEqual(decoded.right, {
    ...query,
    page: { limit: 1, after: cursor },
  })
  assert.ok(
    Object.isFrozen(decoded.right) && Object.isFrozen(decoded.right.page),
  )
})

test("GitHub issue pages decode the recorded qualified response and its real continuation", () => {
  const decoded = decodeGitHubIssueListPage(JSON.stringify(recorded), query)

  assert.ok(Either.isRight(decoded))
  const issue = decodeIssueReference({
    repository: query.repository,
    number: 19,
  })
  assert.ok(Either.isRight(issue))
  assert.deepEqual(decoded.right, {
    repository: query.repository,
    issues: [
      {
        issue: issue.right,
        title: "add avante.nvim plugin",
        url: "https://github.com/0xgleb/dotconfig/issues/19",
        state: "open",
        updatedAt: "2026-03-18T19:15:00Z",
      },
    ],
    pageInfo: { hasNextPage: true, endCursor: cursor },
  })
  assert.ok(
    Object.isFrozen(decoded.right) &&
      Object.isFrozen(decoded.right.issues) &&
      Object.isFrozen(decoded.right.pageInfo),
  )
  assert.ok(
    decoded.right.issues.every(
      row => Object.isFrozen(row) && Object.isFrozen(row.issue),
    ),
  )
})

test("GitHub terminal pages may retain their last non-null cursor", () => {
  const response = structuredClone(recorded)
  response.data.repository.issues.pageInfo.hasNextPage = false
  const decoded = decodeGitHubIssueListPage(JSON.stringify(response), query)

  assert.ok(Either.isRight(decoded))
  assert.deepEqual(decoded.right.pageInfo, {
    hasNextPage: false,
    endCursor: cursor,
  })
})

test("GitHub nullable nodes and unavailable repositories never become empty complete pages", () => {
  for (const nodes of [null, [null]]) {
    const response = {
      data: {
        repository: {
          ...recorded.data.repository,
          issues: { ...recorded.data.repository.issues, nodes },
        },
      },
    }
    failure(JSON.stringify(response), "partial_response")
  }
  failure(JSON.stringify({ data: { repository: null } }), "unavailable")
})

test("GitHub errors alongside data are not complete successful readback", () => {
  failure(
    JSON.stringify({
      ...recorded,
      errors: [{ message: "Unavailable linked data" }],
    }),
    "remote_error",
  )
})

test("GitHub query limits, states and opaque cursors are bounded without caller authority", () => {
  for (const state of ["open", "closed", "all"])
    for (const limit of [1, 100]) {
      const decoded = decodeGitHubIssueListQuery({
        ...query,
        state,
        page: { limit, after: "opaque-cursor" },
      })
      assert.ok(Either.isRight(decoded))
      assert.equal(decoded.right.page.limit, limit)
    }
  for (const input of [
    null,
    [],
    {},
    { repository: query.repository, page: { limit: 1 } },
    { ...query, worker: "forged" },
    { ...query, authority: "owner" },
    { ...query, endpoint: "https://other.invalid" },
    { ...query, [Symbol("hidden")]: true },
    { ...query, page: { limit: 1, [Symbol("hidden")]: true } },
    ...[0, 101, 1.5, NaN, Infinity, "1", null].map(limit => ({
      ...query,
      page: { limit },
    })),
    ...[null, "", 1, "x".repeat(MAX_GITHUB_READ_BYTES + 1)].map(after => ({
      ...query,
      page: { limit: 1, after },
    })),
    { ...query, state: "doing" },
  ]) {
    const decoded = decodeGitHubIssueListQuery(input)
    assert.ok(Either.isLeft(decoded))
    assert.equal(decoded.left.code, "invalid_request")
  }
  const invalidRepository = decodeGitHubIssueListQuery({
    ...query,
    repository: "missing-owner",
  })
  assert.ok(Either.isLeft(invalidRepository))
  assert.equal(invalidRepository.left.code, "invalid_repository")
})

test("GitHub pages reject malformed JSON, envelopes, rows and response errors", () => {
  for (const payload of [
    null,
    {},
    "",
    "{",
    "null",
    "[]",
    JSON.stringify({}),
    JSON.stringify({ data: null }),
    JSON.stringify({ errors: [] }),
    JSON.stringify({ errors: [null] }),
  ])
    failure(payload, "invalid_response")
  const row = recorded.data.repository.issues.nodes[0]
  assert.ok(row)
  for (const patch of [
    { number: 0 },
    { number: 2_147_483_648 },
    { number: "19" },
    { title: null },
    { state: "MERGED" },
    { updatedAt: null },
    { repository: null },
    { url: "https://other.invalid/0xgleb/dotconfig/issues/19" },
    { url: "https://github.com/0xgleb/dotconfig/pull/19" },
    { url: "https://github.com/0xgleb/dotconfig/issues/19?redirect=1" },
    { repository: { nameWithOwner: "other/repo" } },
  ]) {
    const response = {
      data: {
        repository: {
          ...recorded.data.repository,
          issues: {
            ...recorded.data.repository.issues,
            nodes: [{ ...row, ...patch }],
          },
        },
      },
    }
    failure(JSON.stringify(response), "invalid_response")
  }
  failure(
    JSON.stringify({
      data: {
        repository: {
          ...recorded.data.repository,
          nameWithOwner: "other/repo",
        },
      },
    }),
    "invalid_response",
  )
})

test("GitHub pages enforce requested count, unique identities and state filters", () => {
  const row = recorded.data.repository.issues.nodes[0]
  assert.ok(row)
  const response = {
    data: {
      repository: {
        ...recorded.data.repository,
        issues: { ...recorded.data.repository.issues, nodes: [row, row] },
      },
    },
  }
  failure(JSON.stringify(response), "invalid_response")
  failure(JSON.stringify(response), "invalid_response", {
    ...query,
    page: { limit: 2 },
  })
  const closed = {
    data: {
      repository: {
        ...recorded.data.repository,
        issues: {
          ...recorded.data.repository.issues,
          nodes: [{ ...row, state: "CLOSED" }],
        },
      },
    },
  }
  failure(JSON.stringify(closed), "invalid_response")
  const accepted = decodeGitHubIssueListPage(JSON.stringify(closed), {
    ...query,
    state: "all",
  })
  assert.ok(Either.isRight(accepted))
  assert.equal(accepted.right.issues[0]?.state, "closed")
})

test("GitHub continuations require progress only when another page exists", () => {
  for (const endCursor of [null, ""]) {
    const response = {
      data: {
        repository: {
          ...recorded.data.repository,
          issues: {
            ...recorded.data.repository.issues,
            pageInfo: { hasNextPage: true, endCursor },
          },
        },
      },
    }
    failure(JSON.stringify(response), "invalid_response")
  }
  failure(JSON.stringify(recorded), "invalid_response", {
    ...query,
    page: { limit: 1, after: cursor },
  })
  const terminal = structuredClone(recorded)
  terminal.data.repository.issues.pageInfo.hasNextPage = false
  const accepted = decodeGitHubIssueListPage(JSON.stringify(terminal), {
    ...query,
    page: { limit: 1, after: cursor },
  })
  assert.ok(Either.isRight(accepted))
  const empty = {
    data: {
      repository: {
        ...recorded.data.repository,
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }
  const decoded = decodeGitHubIssueListPage(JSON.stringify(empty), query)
  assert.ok(Either.isRight(decoded))
  assert.deepEqual(decoded.right.issues, [])
})

test("GitHub decoder admits the exact byte envelope and preserves Unicode", () => {
  const response = structuredClone(recorded)
  const row = response.data.repository.issues.nodes[0]
  assert.ok(row)
  row.title = "🦆 technical title"
  const json = JSON.stringify(response)
  const payload =
    json + " ".repeat(MAX_GITHUB_READ_BYTES - Buffer.byteLength(json, "utf8"))
  const decoded = decodeGitHubIssueListPage(payload, query)
  assert.ok(Either.isRight(decoded))
  assert.equal(decoded.right.issues[0]?.title, row.title)
  failure(payload, "invalid_request", { ...query, page: { limit: 0 } })
})

test("GitHub response byte capacity is enforced before JSON parsing without truncation", () => {
  failure(" ".repeat(MAX_GITHUB_READ_BYTES + 1), "capacity")
  failure("🦆".repeat(MAX_GITHUB_READ_BYTES / 4 + 1), "capacity")
})
