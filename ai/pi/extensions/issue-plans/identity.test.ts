import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { decodeIssueReference, decodeIssueScope, issueKey } from "./identity.ts"

const issue = (repository = "0xgleb/dotconfig", number = 1) => ({
  repository,
  number,
})

test("repository-qualified identities distinguish identical issue numbers", () => {
  const first = decodeIssueReference(issue())
  const second = decodeIssueReference(issue("dataclique/yielduck"))
  assert.ok(Either.isRight(first))
  assert.ok(Either.isRight(second))
  assert.notEqual(issueKey(first.right), issueKey(second.right))
  assert.equal(issueKey(first.right), "0xgleb/dotconfig#1")
})

test("GitHub repository case does not create independently writable plans", () => {
  const decoded = decodeIssueReference(issue("0xGleb/DotConfig", 361))
  assert.ok(Either.isRight(decoded))
  assert.equal(issueKey(decoded.right), "0xgleb/dotconfig#361")
})

test("malformed and ambiguous issue targets fail at the boundary", () => {
  const invalid: readonly unknown[] = [
    55,
    "0xgleb/dotconfig#55",
    null,
    [],
    { number: 55 },
    { repository: "dotconfig", number: 55 },
    issue("owner/repository/extra"),
    issue("owner/.."),
    issue("owner/."),
    issue("owner/repository\n"),
    issue("K/repo"),
    issue("owner-/repo"),
    issue("owner--name/repo"),
    issue("owner/repository", 0),
    issue("owner/repository", -1),
    issue("owner/repository", 1.5),
    issue("owner/repository", Number.MAX_SAFE_INTEGER + 1),
    issue("owner/repository", Number.NaN),
    { ...issue(), workerSessionId: "stale-worker" },
    { ...issue(), expectedRevisions: {} },
  ]
  for (const value of invalid) {
    const result = decodeIssueReference(value)
    assert.ok(Either.isLeft(result), JSON.stringify(value))
    assert.equal(result.left.code, "invalid_issue")
  }
})

test("multi-issue scope is explicit, bounded and rejects case-equivalent duplicates", () => {
  const accepted = decodeIssueScope([issue(), issue("dataclique/yielduck")])
  assert.ok(Either.isRight(accepted))
  const maximum = decodeIssueScope(
    Array.from({ length: 100 }, (_, index) => issue("owner/repo", index + 1)),
  )
  assert.ok(Either.isRight(maximum))
  assert.equal(maximum.right.length, 100)
  assert.deepEqual(accepted.right.map(issueKey), [
    "0xgleb/dotconfig#1",
    "dataclique/yielduck#1",
  ])
  for (const value of [
    undefined,
    [],
    [issue(), issue("0xGleb/DotConfig")],
    [issue(), { number: 2 }],
    Array(1),
    [issue(), ...Array(1)],
    Array.from({ length: 101 }, (_, index) => issue("owner/repo", index + 1)),
  ]) {
    const result = decodeIssueScope(value)
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_scope")
  }
})
