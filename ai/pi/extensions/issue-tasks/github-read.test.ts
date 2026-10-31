import assert from "node:assert/strict"
import test from "node:test"
import { Cause, Deferred, Effect, Either, Exit } from "effect"
import { decodeIssueReference, decodeIssueRepository } from "./identity.ts"
import {
  createGitHubIssueReader,
  GITHUB_ISSUE_LIST_DOCUMENT,
  type GitHubIssueListExecution,
  decodeGitHubIssueListQuery,
  decodeGitHubIssueListPage,
  MAX_GITHUB_READ_BYTES,
  type GitHubIssueListQuery,
  GitHubReadError,
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

test("GitHub reader executes one fixed list query with validated frozen variables", async () => {
  const calls: GitHubIssueListExecution[] = []
  const reader = createGitHubIssueReader({
    executeQuery: request =>
      Effect.sync(() => {
        calls.push(request)
        return JSON.stringify(recorded)
      }),
  })

  const result = await Effect.runPromise(
    reader.list({
      repository: "0xGleb/DotConfig",
      state: "all",
      page: { limit: 1 },
    }),
  )

  assert.equal(result.issues[0]?.issue.number, 19)
  assert.deepEqual(calls, [
    {
      document: GITHUB_ISSUE_LIST_DOCUMENT,
      variables: {
        owner: "0xgleb",
        name: "dotconfig",
        first: 1,
        after: null,
        states: ["OPEN", "CLOSED"],
      },
    },
  ])
  assert.ok(
    calls.every(
      call =>
        Object.isFrozen(call) &&
        Object.isFrozen(call.variables) &&
        Object.isFrozen(call.variables.states),
    ),
  )
})

test("GitHub reader forwards the real continuation to the independently recorded next page", async () => {
  const nextCursor = "Y3Vyc29yOnYyOpK0MjAyNi0wNS0wMVQxOTowMzoyNlrPAAAAAQQ-dio="
  const following = {
    data: {
      repository: {
        nameWithOwner: "0xgleb/dotconfig",
        issues: {
          nodes: [
            {
              number: 41,
              title: "add tailscale as homebrew cask",
              url: "https://github.com/0xgleb/dotconfig/issues/41",
              state: "OPEN",
              updatedAt: "2026-05-01T19:03:26Z",
              repository: { nameWithOwner: "0xgleb/dotconfig" },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: nextCursor },
        },
      },
    },
  }
  const requests: GitHubIssueListExecution[] = []
  const reader = createGitHubIssueReader({
    executeQuery: request =>
      Effect.sync(() => {
        requests.push(request)
        return JSON.stringify(following)
      }),
  })

  const result = await Effect.runPromise(
    reader.list({ ...query, page: { limit: 1, after: cursor } }),
  )

  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.variables, {
    owner: "0xgleb",
    name: "dotconfig",
    first: 1,
    after: cursor,
    states: ["OPEN"],
  })
  assert.equal(result.issues[0]?.issue.number, 41)
  assert.deepEqual(result.pageInfo, {
    hasNextPage: true,
    endCursor: nextCursor,
  })
})

test("GitHub reader encodes a closed-only query without widening its state filter", async () => {
  const response = structuredClone(recorded)
  const first = response.data.repository.issues.nodes[0]
  assert.ok(first)
  first.state = "CLOSED"
  const requests: GitHubIssueListExecution[] = []
  const reader = createGitHubIssueReader({
    executeQuery: request =>
      Effect.sync(() => {
        requests.push(request)
        return JSON.stringify(response)
      }),
  })

  const result = await Effect.runPromise(
    reader.list({ ...query, state: "closed" }),
  )

  assert.deepEqual(requests[0]?.variables.states, ["CLOSED"])
  assert.equal(result.issues[0]?.state, "closed")
})

test("GitHub reader rejects invalid input before invoking the host query port", async () => {
  let calls = 0
  const reader = createGitHubIssueReader({
    executeQuery: () =>
      Effect.sync(() => {
        calls += 1
        return JSON.stringify(recorded)
      }),
  })

  const result = await Effect.runPromise(
    Effect.either(reader.list({ ...query, page: { limit: 0 } })),
  )

  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_request")
  assert.equal(calls, 0)
})

for (const stop of ["failure", "defect"] as const) {
  test(`GitHub reader projects host ${stop} without private diagnostics or retries`, async () => {
    let calls = 0
    const reader = createGitHubIssueReader({
      executeQuery: () => {
        calls += 1
        return stop === "failure"
          ? Effect.fail(
              new GitHubReadError({
                code: "unavailable",
                message: "Private transport diagnostic",
              }),
            )
          : Effect.die("Private transport diagnostic")
      },
    })

    const result = await Effect.runPromise(Effect.either(reader.list(query)))

    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "transport_error")
    assert.ok(
      !JSON.stringify(result.left).includes("Private transport diagnostic"),
    )
    assert.equal(calls, 1)
  })
}

test(
  "GitHub reader cancellation interrupts the host query effect instead of becoming a transport error",
  { timeout: 5_000 },
  async t => {
    const entered = await Effect.runPromise(Deferred.make<void>())
    const controller = new AbortController()
    t.signal.addEventListener("abort", () => controller.abort(), { once: true })
    let released = false
    const reader = createGitHubIssueReader({
      executeQuery: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              released = true
            }),
          ),
        ),
    })
    const pending = Effect.runPromiseExit(reader.list(query), {
      signal: controller.signal,
    })
    try {
      const started = await Promise.race([
        Effect.runPromise(Deferred.await(entered)).then(() => true),
        pending.then(() => false),
      ])
      assert.equal(started, true)
      controller.abort()
      const result = await pending
      assert.ok(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause))
      assert.equal(released, true)
    } finally {
      controller.abort()
      await pending
    }
  },
)

test("pre-aborted GitHub reads perform no host query", async () => {
  let calls = 0
  const reader = createGitHubIssueReader({
    executeQuery: () =>
      Effect.sync(() => {
        calls += 1
        return JSON.stringify(recorded)
      }),
  })
  const controller = new AbortController()
  controller.abort()
  for (const input of [query, { ...query, page: { limit: 0 } }]) {
    const result = await Effect.runPromiseExit(reader.list(input), {
      signal: controller.signal,
    })
    assert.ok(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause))
  }
  assert.equal(calls, 0)
})

test("GitHub reader preserves typed readback failures after one successful host call", async () => {
  for (const [payload, expected] of [
    [
      JSON.stringify({
        ...recorded,
        errors: [{ message: "Private query error" }],
      }),
      "remote_error",
    ],
    ["x".repeat(MAX_GITHUB_READ_BYTES + 1), "capacity"],
  ] as const) {
    let calls = 0
    const reader = createGitHubIssueReader({
      executeQuery: () =>
        Effect.sync(() => {
          calls += 1
          return payload
        }),
    })
    const result = await Effect.runPromise(Effect.either(reader.list(query)))
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, expected)
    assert.equal(calls, 1)
  }
})

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
