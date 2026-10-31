import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { decodeIssueReference } from "./identity.ts"
import { decodeTaskRequest, type TaskRequestDecodeError } from "./request.ts"

const issue = (repository = "Owner/Repo", number = 12) => {
  const decoded = decodeIssueReference({ repository, number })
  assert.ok(Either.isRight(decoded))
  return decoded.right
}
const a = issue()
const b = issue("Owner/Other")
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const addition = { op: "add", issue: a, key: "one", text: "One" }
const read = { action: "read", issue: a, page: { limit: 1 } }
const get = { action: "get", issue: a, id }
const apply = { action: "apply", issues: [a], operations: [addition] }
const failure = (input: unknown, code: TaskRequestDecodeError["code"]) => {
  const decoded = decodeTaskRequest(input)
  assert.ok(Either.isLeft(decoded))
  assert.equal(decoded.left.code, code)
}

test("task read decodes a detached explicit status and blocker filter", () => {
  const filter = { status: "doing", blocked: false }
  const decoded = decodeTaskRequest({ ...read, filter })

  assert.ok(Either.isRight(decoded))
  assert.deepEqual(decoded.right, {
    ...read,
    filter: { status: "doing", blocked: false },
  })
  filter.status = "done"
  filter.blocked = true
  assert.deepEqual(decoded.right, {
    ...read,
    filter: { status: "doing", blocked: false },
  })
  assert.ok(decoded.right.action === "read")
  assert.ok(Object.isFrozen(decoded.right.filter))
})

test("task filters reject malformed or authority-bearing predicates without coercion", () => {
  for (const filter of [
    null,
    false,
    [],
    { status: null },
    { status: "in_review" },
    { blocked: "false" },
    { blocked: 0 },
    { authority: "owner" },
    { [Symbol("hidden")]: true },
    Object.defineProperty({}, "authority", { value: "owner" }),
  ])
    failure({ ...read, filter }, "invalid_filter")
  failure({ ...get, filter: {} }, "invalid_request")
  failure({ ...apply, filter: {} }, "invalid_request")
})

test("task filters accept all lifecycle statuses and preserve false or omitted predicates", () => {
  for (const status of ["todo", "doing", "done", "cancelled"])
    for (const blocked of [undefined, true, false]) {
      const filter = { status, ...(blocked === undefined ? {} : { blocked }) }
      const decoded = decodeTaskRequest({ ...read, filter })
      assert.ok(Either.isRight(decoded))
      assert.deepEqual(decoded.right, { ...read, filter })
    }
  for (const filter of [{}, { status: undefined, blocked: undefined }]) {
    const decoded = decodeTaskRequest({ ...read, filter })
    assert.ok(Either.isRight(decoded))
    assert.deepEqual(decoded.right, { ...read, filter: {} })
  }
  const omitted = decodeTaskRequest({ ...read, filter: undefined })
  assert.ok(Either.isRight(omitted))
  assert.deepEqual(omitted.right, read)
})

test("task read request canonicalizes its explicit issue and preserves its page", () => {
  const decoded = decodeTaskRequest({
    action: "read",
    issue: { repository: "Owner/Repo", number: 12 },
    page: { limit: 1 },
  })
  assert.ok(Either.isRight(decoded))
  assert.deepEqual(decoded.right, {
    action: "read",
    issue: a,
    page: { limit: 1 },
  })
})

test("task read accepts both page boundaries and a syntactically valid cursor", () => {
  for (const limit of [1, 100]) {
    const decoded = decodeTaskRequest({ ...read, page: { limit, after: id } })
    assert.ok(Either.isRight(decoded))
    assert.deepEqual(decoded.right, { ...read, page: { limit, after: id } })
  }
})

test("task get decodes a canonical qualified task address without granting authority", () => {
  const decoded = decodeTaskRequest({
    ...get,
    issue: { repository: "OWNER/REPO", number: 12 },
  })

  assert.ok(Either.isRight(decoded))
  assert.deepEqual(decoded.right, { action: "get", target: { issue: a, id } })
  assert.equal(decoded.right.action, "get")
  if (decoded.right.action !== "get") assert.fail("Expected get request")

  assert.ok(Object.isFrozen(decoded.right))
  assert.ok(Object.isFrozen(decoded.right.target))
  assert.ok(Object.isFrozen(decoded.right.target.issue))
})

test("task get rejects malformed IDs, missing qualification and extra fields", () => {
  for (const id of [
    undefined,
    null,
    1,
    "not-a-uuid",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  ])
    failure({ ...get, id }, "invalid_task")

  for (const input of [
    { action: "get", id },
    { action: "get", issue: a },
    { ...get, page: { limit: 1 } },
    { ...get, issues: [a] },
    { ...get, [Symbol("hidden")]: true },
  ])
    failure(input, "invalid_request")

  failure({ ...get, issue: { number: 12 } }, "invalid_issue")
})

test("task get detaches its qualified task address from caller mutations", () => {
  const source = {
    action: "get",
    issue: { repository: "Owner/Repo", number: 12 },
    id,
  }

  const decoded = decodeTaskRequest(source)

  assert.ok(Either.isRight(decoded))

  source.issue.repository = "Owner/Other"
  source.id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

  assert.deepEqual(decoded.right, { action: "get", target: { issue: a, id } })
})

test("task apply delegates complete issue-qualified mutations without an independent container", () => {
  const decoded = decodeTaskRequest({
    action: "apply",
    issues: [{ repository: "Owner/Repo", number: 12 }, b],
    operations: [addition, { ...addition, issue: b, text: "Other" }],
  })
  assert.ok(Either.isRight(decoded))
  assert.equal(decoded.right.action, "apply")
  if (decoded.right.action !== "apply") assert.fail("Expected apply request")
  assert.deepEqual(decoded.right.batch.issues, [a, b])
  assert.deepEqual(decoded.right.batch.operations, [
    { ...addition, dependsOn: [] },
    { ...addition, issue: b, text: "Other", dependsOn: [] },
  ])
})

for (const field of [
  "actorId",
  "requestId",
  "now",
  "cancellation",
  "authority",
  "expectedRevisions",
  "worker",
  "planId",
  "reply",
]) {
  test(`task request rejects caller metadata or legacy field: ${field}`, () => {
    for (const input of [read, get, apply])
      failure({ ...input, [field]: "forged" }, "invalid_request")
  })
}

test("task requests reject missing, unknown and legacy action envelopes", () => {
  for (const input of [
    null,
    [],
    "read",
    {},
    { ...read, action: "reply" },
    { ...read, action: "createPlan" },
    { action: "read", issue: a },
    { action: "read", page: { limit: 1 } },
    { action: "apply", issues: [a] },
    { action: "apply", operations: [addition] },
    { ...read, issues: [a] },
    { ...apply, page: { limit: 1 } },
  ])
    failure(input, "invalid_request")
  failure({ ...read, [Symbol("hidden")]: true }, "invalid_request")
  failure({ ...apply, [Symbol("hidden")]: true }, "invalid_request")
})

test("task read rejects malformed pages without coercion or stripping fields", () => {
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity, "1", null])
    failure({ ...read, page: { limit } }, "invalid_page")
  for (const page of [
    null,
    [],
    {},
    { limit: 1, expectedRevision: 2 },
    { limit: 1, [Symbol("hidden")]: true },
  ])
    failure({ ...read, page }, "invalid_page")
  for (const after of [null, "", id.toUpperCase(), "not-a-uuid", 1])
    failure({ ...read, page: { limit: 1, after } }, "invalid_page")
})

test("task read validates qualified issue identity rather than inferring a repository", () => {
  for (const target of [
    { number: 12 },
    { repository: "Owner/Repo", number: 0 },
    { repository: "Owner/Repo", number: 12, planId: id },
    "Owner/Repo#12",
  ])
    failure({ ...read, issue: target }, "invalid_issue")
})

test("task apply rejects duplicate issue scope, missing operations and operation overflow", () => {
  failure(
    { ...apply, issues: [a, { repository: "OWNER/REPO", number: 12 }] },
    "invalid_batch",
  )
  failure({ ...apply, operations: [] }, "invalid_batch")
  failure(
    { ...apply, operations: Array.from({ length: 1_001 }, () => addition) },
    "capacity",
  )
})

test("task apply does not discard unexpected nested mutation fields", () => {
  failure(
    { ...apply, operations: [{ ...addition, authority: "owner" }] },
    "invalid_operation",
  )
  failure(
    {
      ...apply,
      operations: [
        {
          op: "reply",
          target: { issue: a, task: { kind: "existing", id } },
          text: "New assignment",
        },
      ],
    },
    "invalid_operation",
  )
})

test("task apply requires every mutation, dependency and transfer issue in scope", () => {
  failure(
    { ...apply, operations: [{ ...addition, issue: b }] },
    "scope_mismatch",
  )
  failure(
    {
      ...apply,
      operations: [
        {
          ...addition,
          dependsOn: [{ issue: b, task: { kind: "existing", id } }],
        },
      ],
    },
    "scope_mismatch",
  )
  failure(
    {
      ...apply,
      operations: [
        {
          op: "transfer",
          target: { issue: a, task: { kind: "existing", id } },
          toIssue: b,
        },
      ],
    },
    "scope_mismatch",
  )
})

test("task decoding treats lifecycle intent as data, not a cancellation grant", () => {
  const decoded = decodeTaskRequest({
    ...apply,
    operations: [
      {
        op: "status",
        target: { issue: a, task: { kind: "existing", id } },
        status: "cancelled",
      },
    ],
  })
  assert.ok(Either.isRight(decoded))
  failure(
    {
      ...apply,
      operations: [
        {
          op: "status",
          target: { issue: a, task: { kind: "existing", id } },
          status: "in_review",
        },
      ],
    },
    "invalid_operation",
  )
})

test("decoded requests detach from mutable caller data and are immutable", () => {
  const source = {
    action: "read",
    issue: { repository: "Owner/Repo", number: 12 },
    page: { limit: 1, after: id },
  }
  const decoded = decodeTaskRequest(source)
  assert.ok(Either.isRight(decoded))
  assert.equal(decoded.right.action, "read")
  if (decoded.right.action !== "read") assert.fail("Expected read request")
  source.issue.repository = "Owner/Other"
  source.page.limit = 100
  source.page.after = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  assert.deepEqual(decoded.right, { ...read, page: { limit: 1, after: id } })
  assert.ok(Object.isFrozen(decoded.right))
  assert.ok(Object.isFrozen(decoded.right.issue))
  assert.ok(Object.isFrozen(decoded.right.page))
  const write = decodeTaskRequest(apply)
  assert.ok(Either.isRight(write))
  assert.ok(Object.isFrozen(write.right))
})
