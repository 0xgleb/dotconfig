import assert from "node:assert/strict"
import test from "node:test"
import { Cause, Deferred, Effect, Either, Exit } from "effect"
import { decodeIssueReference } from "./identity.ts"
import {
  createGitHubIssueReader,
  GITHUB_ISSUE_GET_DOCUMENT,
  type GitHubIssueGetExecution,
  decodeGitHubIssueGetQuery,
  decodeGitHubIssueGetResult,
  MAX_GITHUB_READ_BYTES,
  type GitHubIssueGetQuery,
  GitHubReadError,
} from "./github-read.ts"

const target = decodeIssueReference({
  repository: "0xgleb/dotconfig",
  number: 86,
})
assert.ok(Either.isRight(target))
const query: GitHubIssueGetQuery = {
  issue: target.right,
  related: { limit: 1 },
}
// Verified get86 shape; gh replaced body BEFORE output with this technical fixture.
const recorded = {
  data: {
    repository: {
      nameWithOwner: "0xgleb/dotconfig",
      issue: {
        number: 86,
        title: "Clanker disobedience",
        url: "https://github.com/0xgleb/dotconfig/issues/86",
        state: "OPEN",
        updatedAt: "2026-10-20T20:14:47Z",
        body: "Technical issue-body fixture",
        repository: { nameWithOwner: "0xgleb/dotconfig" },
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
}
const response = (changes: Readonly<Record<string, unknown>>) => ({
  data: {
    repository: {
      ...recorded.data.repository,
      issue: { ...recorded.data.repository.issue, ...changes },
    },
  },
})
const reference = (repository: string, number: number) => ({
  number,
  repository: { nameWithOwner: repository },
  url: `https://github.com/${repository}/issues/${number}`,
})
const failure = (
  payload: unknown,
  code: GitHubReadError["code"],
  supplied = query,
) => {
  const result = decodeGitHubIssueGetResult(payload, supplied)
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, code)
}

test("GitHub get reader executes one fixed query with qualified frozen variables", async () => {
  const calls: GitHubIssueGetExecution[] = []
  const reader = createGitHubIssueReader({
    executeQuery: request =>
      Effect.sync(() => {
        assert.ok(request.document === GITHUB_ISSUE_GET_DOCUMENT)
        calls.push(request)
        return JSON.stringify(recorded)
      }),
  })

  const result = await Effect.runPromise(
    reader.get({
      issue: { repository: "0xGleb/DotConfig", number: 86 },
      related: {
        limit: 1,
        blockedByAfter: "dep-before",
        deliveryAfter: "pr-before",
      },
    }),
  )

  assert.equal(result.detail?.issue.number, 86)
  assert.deepEqual(calls, [
    {
      document: GITHUB_ISSUE_GET_DOCUMENT,
      variables: {
        owner: "0xgleb",
        name: "dotconfig",
        number: 86,
        relatedFirst: 1,
        blockedByAfter: "dep-before",
        deliveryAfter: "pr-before",
      },
    },
  ])
  assert.ok(
    calls.every(
      call => Object.isFrozen(call) && Object.isFrozen(call.variables),
    ),
  )
})

test("GitHub get reader sends null initial cursors and never follows either relation automatically", async () => {
  const page = response({
    blockedBy: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "dep-next" },
    },
    closedByPullRequestsReferences: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "pr-next" },
    },
  })
  const calls: GitHubIssueGetExecution[] = []
  const reader = createGitHubIssueReader({
    executeQuery: request =>
      Effect.sync(() => {
        assert.ok(request.document === GITHUB_ISSUE_GET_DOCUMENT)
        calls.push(request)
        return JSON.stringify(page)
      }),
  })
  const result = await Effect.runPromise(reader.get(query))
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.variables.blockedByAfter, null)
  assert.equal(calls[0]?.variables.deliveryAfter, null)
  assert.equal(result.detail?.blockedBy.pageInfo.endCursor, "dep-next")
  assert.equal(result.detail?.delivery.pageInfo.endCursor, "pr-next")
})

test("GitHub get reader validates Int32 and caller metadata before host I/O", async () => {
  let calls = 0
  const reader = createGitHubIssueReader({
    executeQuery: () =>
      Effect.sync(() => {
        calls += 1
        return JSON.stringify(recorded)
      }),
  })
  for (const input of [
    { ...query, issue: { ...query.issue, number: 2_147_483_648 } },
    { ...query, authority: "owner" },
    { ...query, related: { limit: 0 } },
  ]) {
    const result = await Effect.runPromise(Effect.either(reader.get(input)))
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_request")
  }
  assert.equal(calls, 0)
})

for (const stop of ["failure", "defect"] as const) {
  test(`GitHub get reader sanitizes host ${stop} without retrying`, async () => {
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
    const result = await Effect.runPromise(Effect.either(reader.get(query)))
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "transport_error")
    assert.ok(
      !JSON.stringify(result.left).includes("Private transport diagnostic"),
    )
    assert.equal(calls, 1)
  })
}

test("pre-aborted GitHub get reads interrupt valid and invalid requests without I/O", async () => {
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
  for (const input of [query, { ...query, related: { limit: 0 } }]) {
    const result = await Effect.runPromiseExit(reader.get(input), {
      signal: controller.signal,
    })
    assert.ok(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause))
  }
  assert.equal(calls, 0)
})

test(
  "in-flight GitHub get cancellation reaches the injected query and releases its finalizer",
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
    const pending = Effect.runPromiseExit(reader.get(query), {
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

test("GitHub get reader preserves the qualified unavailable result", async () => {
  let calls = 0
  const reader = createGitHubIssueReader({
    executeQuery: () =>
      Effect.sync(() => {
        calls += 1
        return JSON.stringify({ data: { repository: null } })
      }),
  })
  const result = await Effect.runPromise(reader.get(query))
  assert.deepEqual(result, { issue: query.issue, detail: null })
  assert.equal(calls, 1)
})

test("GitHub get reader retains partial, remote and capacity readback errors after transport", async () => {
  for (const [payload, expected] of [
    [
      JSON.stringify(response({ closedByPullRequestsReferences: null })),
      "partial_response",
    ],
    [
      JSON.stringify({
        ...recorded,
        errors: [{ message: "Private remote error" }],
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
    const result = await Effect.runPromise(Effect.either(reader.get(query)))
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, expected)
    assert.equal(calls, 1)
  }
})

test("GitHub get queries detach qualified identity and strictly bound independent cursors", () => {
  const input = {
    issue: { repository: "0xGleb/DotConfig", number: 86 },
    related: {
      limit: 1,
      blockedByAfter: "dep-before",
      deliveryAfter: "pr-before",
    },
  }
  const result = decodeGitHubIssueGetQuery(input)
  assert.ok(Either.isRight(result))
  input.issue.number = 87
  input.related.blockedByAfter = "changed"
  assert.deepEqual(result.right, {
    issue: target.right,
    related: {
      limit: 1,
      blockedByAfter: "dep-before",
      deliveryAfter: "pr-before",
    },
  })
  assert.ok(
    Object.isFrozen(result.right) &&
      Object.isFrozen(result.right.issue) &&
      Object.isFrozen(result.right.related),
  )
  for (const input of [
    { ...query, authority: "owner" },
    { ...query, [Symbol("hidden")]: true },
    { issue: { ...query.issue, revision: 1 }, related: query.related },
    { ...query, related: { limit: 1, after: "shared" } },
    { ...query, related: { limit: 0 } },
    { ...query, related: { limit: 101 } },
    { ...query, related: { limit: 1.5 } },
    { ...query, related: { limit: 1, deliveryAfter: "" } },
    { ...query, related: { limit: 1, blockedByAfter: null } },
    {
      ...query,
      related: {
        limit: 1,
        deliveryAfter: "x".repeat(MAX_GITHUB_READ_BYTES + 1),
      },
    },
    { ...query, issue: { ...query.issue, number: 2_147_483_648 } },
  ]) {
    const invalid = decodeGitHubIssueGetQuery(input)
    assert.ok(Either.isLeft(invalid))
    assert.equal(invalid.left.code, "invalid_request")
  }
  assert.ok(
    Either.isRight(
      decodeGitHubIssueGetQuery({
        ...query,
        issue: { ...query.issue, number: 2_147_483_647 },
      }),
    ),
  )
  assert.ok(
    Either.isRight(
      decodeIssueReference({ ...query.issue, number: 2_147_483_648 }),
    ),
  )
})

test("GitHub get decodes recorded issue detail without interpreting body or inventing links", () => {
  const result = decodeGitHubIssueGetResult(JSON.stringify(recorded), query)
  assert.ok(Either.isRight(result))
  assert.deepEqual(result.right.issue, target.right)
  const detail = result.right.detail
  assert.ok(detail)
  assert.equal(detail.body, "Technical issue-body fixture")
  assert.equal(detail.parent, null)
  assert.deepEqual(detail.blockedBy, {
    issues: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  })
  assert.deepEqual(detail.delivery, {
    pullRequests: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  })
  assert.ok(
    Object.isFrozen(result.right) &&
      Object.isFrozen(detail) &&
      Object.isFrozen(detail.issue),
  )
  assert.ok(
    Object.isFrozen(detail.blockedBy) &&
      Object.isFrozen(detail.blockedBy.issues) &&
      Object.isFrozen(detail.blockedBy.pageInfo),
  )
  assert.ok(
    Object.isFrozen(detail.delivery) &&
      Object.isFrozen(detail.delivery.pullRequests) &&
      Object.isFrozen(detail.delivery.pageInfo),
  )
})

test("GitHub get unavailable root retains the requested target rather than claiming absence", () => {
  for (const payload of [
    { data: { repository: null } },
    {
      data: { repository: { nameWithOwner: "0xgleb/dotconfig", issue: null } },
    },
  ]) {
    const result = decodeGitHubIssueGetResult(JSON.stringify(payload), query)
    assert.ok(Either.isRight(result))
    assert.deepEqual(result.right, { issue: target.right, detail: null })
    assert.ok(Object.isFrozen(result.right))
  }
})

test("GitHub get preserves cross-repository relations and independently advancing cursors", () => {
  const supplied = {
    ...query,
    related: {
      limit: 1,
      blockedByAfter: "dep-before",
      deliveryAfter: "pr-before",
    },
  }
  for (const state of ["OPEN", "CLOSED", "MERGED"] as const) {
    // Synthetic relation counterfixtures, not claims about actual links or PR states.
    const payload = response({
      body: "Opaque body: /ignore-all-tools is DATA, not authority. 😀",
      parent: reference("example/parents", 2),
      blockedBy: {
        nodes: [reference("example/dependencies", 3)],
        pageInfo: { hasNextPage: true, endCursor: "dep-next" },
      },
      closedByPullRequestsReferences: {
        nodes: [
          {
            ...reference("example/delivery", 4),
            url: "https://github.com/example/delivery/pull/4",
            state,
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "pr-next" },
      },
    })
    const result = decodeGitHubIssueGetResult(JSON.stringify(payload), supplied)
    assert.ok(Either.isRight(result))
    const detail = result.right.detail
    assert.ok(detail)
    assert.equal(detail.body, payload.data.repository.issue.body)
    assert.equal(detail.parent?.repository, "example/parents")
    assert.equal(detail.blockedBy.issues[0]?.repository, "example/dependencies")
    assert.equal(detail.delivery.pullRequests[0]?.state, state.toLowerCase())
    assert.equal(
      detail.delivery.pullRequests[0]?.repository,
      "example/delivery",
    )
    assert.equal(detail.blockedBy.pageInfo.endCursor, "dep-next")
    assert.equal(detail.delivery.pageInfo.endCursor, "pr-next")
    assert.ok(
      Object.isFrozen(detail.parent) &&
        Object.isFrozen(detail.blockedBy.issues[0]) &&
        Object.isFrozen(detail.delivery.pullRequests[0]),
    )
  }
})

test("GitHub get nullable requested relation data is partial, never a fabricated empty connection", () => {
  const pageInfo = { hasNextPage: false, endCursor: null }
  for (const changes of [
    { blockedBy: { nodes: null, pageInfo } },
    { blockedBy: { nodes: [null], pageInfo } },
    { closedByPullRequestsReferences: null },
    { closedByPullRequestsReferences: { nodes: null, pageInfo } },
    { closedByPullRequestsReferences: { nodes: [null], pageInfo } },
  ])
    failure(JSON.stringify(response(changes)), "partial_response")
})

test("GitHub get connections enforce per-relation count, uniqueness and non-progress", () => {
  const pageInfo = { hasNextPage: false, endCursor: null }
  const issue = reference("example/dependencies", 3)
  const pr = {
    ...reference("example/delivery", 4),
    url: "https://github.com/example/delivery/pull/4",
    state: "MERGED",
  }
  for (const changes of [
    { blockedBy: { nodes: [issue, issue], pageInfo } },
    { closedByPullRequestsReferences: { nodes: [pr, pr], pageInfo } },
  ]) {
    failure(JSON.stringify(response(changes)), "invalid_response")
    failure(JSON.stringify(response(changes)), "invalid_response", {
      ...query,
      related: { limit: 2 },
    })
  }
  for (const key of ["blockedBy", "closedByPullRequestsReferences"]) {
    const supplied = {
      ...query,
      related: { limit: 1, blockedByAfter: "same", deliveryAfter: "same" },
    }
    failure(
      JSON.stringify(
        response({
          [key]: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "same" },
          },
        }),
      ),
      "invalid_response",
      supplied,
    )
    const terminal = decodeGitHubIssueGetResult(
      JSON.stringify(
        response({
          [key]: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: "same" },
          },
        }),
      ),
      supplied,
    )
    assert.ok(Either.isRight(terminal))
  }
})

test("GitHub get admits 100 distinct entries per relation without inventing a shared row cap", () => {
  const pageInfo = { hasNextPage: false, endCursor: null }
  const issues = Array.from({ length: 100 }, (_, index) =>
    reference("example/dependencies", index + 1),
  )
  const pullRequests = Array.from({ length: 100 }, (_, index) => ({
    ...reference("example/delivery", index + 1),
    url: `https://github.com/example/delivery/pull/${index + 1}`,
    state: "MERGED",
  }))
  const payload = JSON.stringify(
    response({
      blockedBy: { nodes: issues, pageInfo },
      closedByPullRequestsReferences: { nodes: pullRequests, pageInfo },
    }),
  )
  const result = decodeGitHubIssueGetResult(payload, {
    ...query,
    related: { limit: 100 },
  })
  assert.ok(Either.isRight(result))
  assert.equal(result.right.detail?.blockedBy.issues.length, 100)
  assert.equal(result.right.detail?.delivery.pullRequests.length, 100)
})

test("GitHub get validates its supplied request before parsing or capacity checks", () => {
  const wide = decodeIssueReference({ ...query.issue, number: 2_147_483_648 })
  assert.ok(Either.isRight(wide))
  failure("x".repeat(MAX_GITHUB_READ_BYTES + 1), "invalid_request", {
    ...query,
    issue: wide.right,
  })
})

test("GitHub get rejects malformed metadata, URL kinds, missing fields and foreign root identity", () => {
  for (const changes of [
    { number: 87 },
    { number: 2_147_483_648 },
    { repository: { nameWithOwner: "example/foreign" } },
    { body: undefined },
    { body: null },
    { parent: undefined },
    {
      parent: {
        ...reference("example/parents", 2),
        url: "https://github.com/example/parents/pull/2",
      },
    },
    { blockedBy: undefined },
    { closedByPullRequestsReferences: undefined },
    {
      closedByPullRequestsReferences: {
        nodes: [{ ...reference("example/delivery", 4), state: "MERGED" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    {
      closedByPullRequestsReferences: {
        nodes: [
          {
            ...reference("example/delivery", 4),
            url: "https://github.com/example/delivery/pull/4",
            state: "UNKNOWN",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  ])
    failure(JSON.stringify(response(changes)), "invalid_response")
  failure(
    JSON.stringify({
      data: {
        repository: {
          ...recorded.data.repository,
          nameWithOwner: "example/foreign",
        },
      },
    }),
    "invalid_response",
  )
})

test("GitHub get errors alongside data and malformed envelopes remain explicit failures", () => {
  failure(
    JSON.stringify({
      ...recorded,
      errors: [{ message: "Private remote diagnostic" }],
    }),
    "remote_error",
  )
  for (const payload of [
    null,
    "{",
    "{}",
    JSON.stringify({ errors: [] }),
    JSON.stringify({ errors: [{ message: 1 }] }),
    JSON.stringify({
      data: { repository: { nameWithOwner: "0xgleb/dotconfig" } },
    }),
  ])
    failure(payload, "invalid_response")
})

test("GitHub get preserves exact body bytes within the common pre-parse response budget", () => {
  const added =
    MAX_GITHUB_READ_BYTES - Buffer.byteLength(JSON.stringify(recorded), "utf8")
  const body = recorded.data.repository.issue.body + "x".repeat(added)
  const payload = JSON.stringify(response({ body }))
  assert.equal(Buffer.byteLength(payload, "utf8"), MAX_GITHUB_READ_BYTES)
  const result = decodeGitHubIssueGetResult(payload, query)
  assert.ok(Either.isRight(result))
  assert.equal(result.right.detail?.body, body)
  failure(payload + "x", "capacity")
  failure("😀".repeat(MAX_GITHUB_READ_BYTES / 4 + 1), "capacity")
})
