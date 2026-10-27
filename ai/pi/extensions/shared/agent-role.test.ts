import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { AGENT_ROLES, decodeAgentRole } from "./agent-role.ts"

for (const role of ["manager", "driver-worker", "review-worker"] as const) {
  test(`agent role decoding preserves ${role}`, () => {
    const result = decodeAgentRole(role)

    assert.ok(Either.isRight(result))
    assert.equal(result.right, role)
  })
}

test("agent role membership has exactly the canonical contract", () => {
  assert.deepEqual(AGENT_ROLES, ["manager", "driver-worker", "review-worker"])
})

test("agent roles reject unknown names and normalization aliases", () => {
  for (const role of [
    "custom-worker",
    "Manager",
    "driver_worker",
    "driver-worker ",
    " review-worker",
    "",
  ]) {
    const result = decodeAgentRole(role)

    assert.ok(Either.isLeft(result))
    assert.equal(result.left._tag, "AgentRoleDecodeError")
    assert.equal(result.left.code, "invalid_agent_role")
  }
})

test("malformed agent roles fail without coercion or input disclosure", () => {
  const sensitive = "sensitive-role-sentinel"
  const object = {
    toString: () => {
      assert.fail("role decoding must not coerce objects")
    },
  }

  for (const role of [undefined, null, 1, true, [], object, sensitive]) {
    const result = decodeAgentRole(role)

    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_agent_role")
    assert.doesNotMatch(result.left.message, /sensitive-role-sentinel/)
  }
})
