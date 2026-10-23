import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"
import { Either } from "effect"
import { signManagerPriority } from "./manager-pair-protocol.ts"
import {
  OWNER_PROGRESS_CHECK_IN_MS,
  SUPERVISED_OWNER_ALLOWANCE_MS,
} from "./owner-allowance.ts"
import {
  signManagerProgressRequest,
  verifyManagerProgressRequest,
  type ManagerProgressIntent,
} from "./manager-progress-protocol.ts"

const TEST_CAPABILITY = "ab".repeat(32)
const start = 100_000_000
const now = start + OWNER_PROGRESS_CHECK_IN_MS
const scope = { workerSessionId: "worker-a", cwd: "/fixture/worker" }
const intent: ManagerProgressIntent = {
  ...scope,
  managerSessionId: "manager-a",
  ownerAt: start,
  deadlineAt: start + SUPERVISED_OWNER_ALLOWANCE_MS,
  sequence: 1,
  scheduledAt: now,
  revision: "revision-a",
}
const signed = (input = intent, at = now) => {
  const result = signManagerProgressRequest(input, TEST_CAPABILITY, at)
  if (Either.isLeft(result)) throw new Error(result.left.message)
  return result.right
}
const verify = (value: unknown, at = now) =>
  verifyManagerProgressRequest(value, scope, "manager-a", TEST_CAPABILITY, at)
const code = (result: ReturnType<typeof verify>) =>
  Either.match(result, {
    onLeft: error => error.code,
    onRight: () => "verified",
  })

test("an exact-worker read-only check-in is authenticated for its exact native manager", () => {
  const request = signed()
  assert.equal(code(verify(request)), "verified")
  assert.equal(request.kind, "manager-progress-check-in")
  assert.equal(request.version, 1)
  assert.equal(request.ownerAt, start)
  assert.equal(request.deadlineAt, intent.deadlineAt)
  assert.equal(Object.isFrozen(request), true)
  const { signature, ...body } = request
  assert.equal(
    signature,
    createHmac("sha256", TEST_CAPABILITY)
      .update(JSON.stringify(body))
      .digest("hex"),
  )
})

test("logical interval identity is stable across retries, revisions and manager replacement", () => {
  const first = signed()
  assert.equal(first.id, signed().id)
  const replacement = signed({
    ...intent,
    managerSessionId: "manager-b",
    revision: "revision-b",
  })
  assert.equal(first.id, replacement.id)
  assert.notEqual(first.signature, replacement.signature)
  assert.notEqual(
    first.id,
    signed({ ...intent, workerSessionId: "worker-b" }).id,
  )
  assert.notEqual(first.id, signed({ ...intent, cwd: "/fixture/other" }).id)
  assert.notEqual(
    first.id,
    signed(
      {
        ...intent,
        sequence: 2,
        scheduledAt: start + 2 * OWNER_PROGRESS_CHECK_IN_MS,
      },
      start + 2 * OWNER_PROGRESS_CHECK_IN_MS,
    ).id,
  )
})

test("audience and worker scope mismatches never verify", () => {
  const request = signed()
  assert.equal(
    code(
      verifyManagerProgressRequest(
        request,
        { ...scope, workerSessionId: "worker-b" },
        "manager-a",
        TEST_CAPABILITY,
        now,
      ),
    ),
    "scope",
  )
  assert.equal(
    code(
      verifyManagerProgressRequest(
        request,
        { ...scope, cwd: "/fixture/other" },
        "manager-a",
        TEST_CAPABILITY,
        now,
      ),
    ),
    "scope",
  )
  assert.equal(
    code(
      verifyManagerProgressRequest(
        request,
        scope,
        "manager-b",
        TEST_CAPABILITY,
        now,
      ),
    ),
    "scope",
  )
})

test("every authenticated scheduling or revision field is bound by the signature", () => {
  const request = signed()
  for (const changed of [
    { revision: "changed" },
    { deadlineAt: request.deadlineAt - 1 },
    { managerSessionId: "manager-b" },
  ]) {
    const altered = { ...request, ...changed }
    const audience = altered.managerSessionId
    assert.equal(
      code(
        verifyManagerProgressRequest(
          altered,
          scope,
          audience,
          TEST_CAPABILITY,
          now,
        ),
      ),
      "authentication",
    )
  }
  assert.equal(
    code(
      verifyManagerProgressRequest(
        request,
        scope,
        "manager-a",
        "cd".repeat(32),
        now,
      ),
    ),
    "authentication",
  )
})

test("a priority-command signature cannot be replayed as a progress capability", () => {
  const request = signed()
  const priority = signManagerPriority(
    scope,
    request.id,
    request.revision,
    "1 2",
    TEST_CAPABILITY,
  )
  if (Either.isLeft(priority)) throw new Error(priority.left.message)
  assert.equal(
    code(verify({ ...request, signature: priority.right.signature })),
    "authentication",
  )
})

test("the original owner deadline is exclusive and no future interval can run early", () => {
  const request = signed()
  assert.equal(code(verify(request, request.scheduledAt - 1)), "not-due")
  assert.equal(code(verify(request, request.deadlineAt)), "expired")
  assert.equal(code(verify(request, request.deadlineAt + 1)), "expired")
  const child = signed({ ...intent, deadlineAt: start + 45 * 60 * 1000 })
  assert.equal(code(verify(child)), "verified")
  assert.equal(code(verify(child, child.deadlineAt)), "expired")
})

test("malformed owner windows, clocks, scopes and interval arithmetic fail specifically", () => {
  for (const changed of [
    { ownerAt: Number.NaN },
    { deadlineAt: intent.deadlineAt + 1 },
    { deadlineAt: intent.scheduledAt },
    { sequence: 0 },
    { sequence: 8 },
    { sequence: 1.5 },
    { scheduledAt: intent.scheduledAt + 1 },
    { cwd: "relative" },
    { workerSessionId: "bad/id" },
    { managerSessionId: "bad/id" },
    { revision: "bad revision" },
  ]) {
    const result = signManagerProgressRequest(
      { ...intent, ...changed },
      TEST_CAPABILITY,
      now,
    )
    assert.equal(code(result), "malformed")
  }
  for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, -1])
    assert.equal(code(verify(signed(), clock)), "malformed")
})

test("extra authority fields, changed purpose and malformed authentication are rejected", () => {
  const request = signed()
  for (const changed of [
    { version: 2 },
    { kind: "execute" },
    { tools: ["bash"] },
    { renewDeadline: true },
    { signature: "not-a-signature" },
    { [Symbol("extra")]: true },
  ])
    assert.equal(code(verify({ ...request, ...changed })), "malformed")
  for (const raw of [null, true, [], {}, "request"])
    assert.equal(code(verify(raw)), "malformed")
})

test("wire decoding does not execute accessors and contains descriptor traps", () => {
  const request = signed()
  let reads = 0
  const accessor = { ...request }
  Object.defineProperty(accessor, "deadlineAt", {
    get: () => {
      reads++
      return request.deadlineAt
    },
  })
  assert.equal(code(verify(accessor)), "malformed")
  assert.equal(reads, 0)
  const trapped = new Proxy(request, {
    ownKeys: () => {
      throw new Error("Fixture descriptor trap")
    },
  })
  assert.doesNotThrow(() => verify(trapped))
  assert.equal(code(verify(trapped)), "malformed")
})

test("revoked proxies remain a typed malformed boundary result", () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  assert.doesNotThrow(() => verify(proxy))
  assert.equal(code(verify(proxy)), "malformed")
})

test("signing and verification return detached immutable snapshots", () => {
  const original = { ...intent }
  const request = signed(original)
  original.deadlineAt++
  assert.equal(request.deadlineAt, intent.deadlineAt)
  const verified = verify(request)
  if (Either.isLeft(verified)) throw new Error(verified.left.message)
  assert.notEqual(verified.right, request)
  assert.equal(Object.isFrozen(verified.right), true)
})
