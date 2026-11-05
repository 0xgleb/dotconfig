import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Schema } from "effect"
import * as contract from "./job-request.ts"
import { JobRequestError, JobRequest } from "./job-request.ts"

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const validRequest = () => ({
  version: 1,
  jobId: uuid(1),
  prompt: "Review the changed modules and report findings with evidence.",
  allowedTools: ["read", "grep", "workflow_audit"],
  execution: {
    cwd: "/Users/0xgleb/code/dataclique/metagenda",
    model: "anthropic/claude-opus-4.6",
    reasoning: "medium" as const,
  },
  budget: { tokenBudget: 250_000, timeoutMs: 600_000, retries: 1 },
})

const expectMalformed = async (input: unknown) => {
  const result = await Effect.runPromise(
    Effect.either(contract.decodeJobRequest(input)),
  )
  assert.equal(result._tag, "Left")
  if (result._tag === "Left") {
    assert.ok(result.left instanceof JobRequestError)
    assert.equal(result.left.code, "malformed")
  }
}

test("exposes the decode boundary as a callable export", () => {
  assert.equal(
    typeof contract.decodeJobRequest,
    "function",
    "decodeJobRequest must be exported as a function",
  )
})

test("decodes a resolved request into a deeply frozen value", async () => {
  const input = validRequest()
  const request = await Effect.runPromise(contract.decodeJobRequest(input))
  assert.equal(request.prompt, input.prompt)
  assert.deepEqual([...request.allowedTools], input.allowedTools)
  assert.equal(request.execution.cwd, input.execution.cwd)
  assert.equal(request.execution.model, input.execution.model)
  assert.equal(request.execution.reasoning, "medium")
  assert.equal(request.budget.tokenBudget, 250_000)
  assert.equal(request.budget.timeoutMs, 600_000)
  assert.equal(request.budget.retries, 1)
  assert.notEqual(request, input)
  assert.ok(Object.isFrozen(request))
  assert.ok(Object.isFrozen(request.execution))
  assert.ok(Object.isFrozen(request.budget))
  assert.ok(Object.isFrozen(request.allowedTools))
})

test("frozen requests reject strict-mode mutation of every preserved field", async () => {
  const request = await Effect.runPromise(
    contract.decodeJobRequest(validRequest()),
  )
  assert.throws(() => {
    ;(request as { prompt: string }).prompt = "rewritten"
  }, TypeError)
  assert.throws(() => {
    ;(request.execution as { cwd: string }).cwd = "/tmp"
  }, TypeError)
  assert.throws(() => {
    ;(request.budget as { tokenBudget: number }).tokenBudget = 1
  }, TypeError)
  assert.throws(() => {
    ;(request.allowedTools as string[]).push("bash")
  }, TypeError)
  assert.throws(() => {
    ;(request.allowedTools as string[])[0] = "edit"
  }, TypeError)
  assert.equal(
    request.prompt,
    "Review the changed modules and report findings with evidence.",
  )
})

test("later mutation of the submitted input cannot alter the preserved request", async () => {
  const input = validRequest()
  const request = await Effect.runPromise(contract.decodeJobRequest(input))
  input.prompt = "changed afterwards"
  input.allowedTools.push("bash")
  input.execution.model = ""
  input.budget.retries = 3
  assert.equal(
    request.prompt,
    "Review the changed modules and report findings with evidence.",
  )
  assert.deepEqual(
    [...request.allowedTools],
    ["read", "grep", "workflow_audit"],
  )
  assert.equal(request.execution.model, "anthropic/claude-opus-4.6")
  assert.equal(request.budget.retries, 1)
})

test("unresolved invocation metadata never reaches the preserved request", async () => {
  const base = validRequest()
  await expectMalformed({ ...base, allowedTools: "read,grep" })
  await expectMalformed({
    ...base,
    execution: { ...base.execution, model: "" },
  })
  await expectMalformed({
    ...base,
    execution: { ...base.execution, model: undefined },
  })
  await expectMalformed({
    ...base,
    execution: {
      ...base.execution,
      reasoning: "inherit" as unknown as typeof base.execution.reasoning,
    },
  })
  await expectMalformed({
    ...base,
    execution: { ...base.execution, cwd: "src" },
  })
  await expectMalformed({
    ...base,
    execution: { ...base.execution, cwd: "" },
  })
})

test("allowed tools must be a resolved, duplicate-free, bounded set", async () => {
  const base = validRequest()
  await expectMalformed({ ...base, allowedTools: [] })
  await expectMalformed({
    ...base,
    allowedTools: Array.from({ length: 17 }, () => "read"),
  })
  await expectMalformed({ ...base, allowedTools: ["read", "read"] })
  await expectMalformed({ ...base, allowedTools: [""] })
  await expectMalformed({
    ...base,
    allowedTools: ["a".repeat(65)],
  })
  const sixteen = Array.from({ length: 16 }, (_, i) => `tool-${i}`)
  const accepted = await Effect.runPromise(
    contract.decodeJobRequest({ ...base, allowedTools: sixteen }),
  )
  assert.equal(accepted.allowedTools.length, 16)
})

test("allocated budget keeps the workflow envelope bounds", async () => {
  const base = validRequest()
  for (const tokenBudget of [3_999, 5_000_001, 2.5]) {
    await expectMalformed({ ...base, budget: { ...base.budget, tokenBudget } })
  }
  for (const timeoutMs of [179_999, 900_001, 60_000]) {
    await expectMalformed({ ...base, budget: { ...base.budget, timeoutMs } })
  }
  for (const retries of [-1, 4]) {
    await expectMalformed({ ...base, budget: { ...base.budget, retries } })
  }
})

test("malformed envelopes, identities, and prompts fail at the boundary", async () => {
  const base = validRequest()
  await expectMalformed({ ...base, version: 2 })
  await expectMalformed({ ...base, unexpected: true })
  await expectMalformed({
    ...base,
    jobId: "AAAAAAAA-0000-4000-8000-000000000001",
  })
  await expectMalformed({ ...base, prompt: "" })
  await expectMalformed({ ...base, prompt: "a".repeat(20_001) })
  const bounded = await Effect.runPromise(
    contract.decodeJobRequest({ ...base, prompt: "a".repeat(20_000) }),
  )
  assert.equal(bounded.prompt.length, 20_000)
})

const decodeSync = (input: unknown) =>
  Schema.decodeUnknownSync(JobRequest, { onExcessProperty: "error" })(input)

const expectSchemaRejection = (input: unknown) => {
  assert.throws(() => decodeSync(input))
}

test("a valid request decoded through the committed surface is not yet preserved frozen", () => {
  const request = decodeSync(validRequest())
  assert.ok(Object.isFrozen(request), "decoded request must be deeply frozen")
  assert.ok(
    Object.isFrozen(request.execution),
    "execution metadata must be frozen",
  )
  assert.ok(Object.isFrozen(request.budget), "budget must be frozen")
  assert.ok(
    Object.isFrozen(request.allowedTools),
    "allowed tools must be frozen",
  )
})

test("the declared schema itself rejects unresolved tool spellings and bounds", () => {
  const base = validRequest()
  expectSchemaRejection({ ...base, allowedTools: "read,grep" })
  expectSchemaRejection({ ...base, allowedTools: [] })
  expectSchemaRejection({ ...base, allowedTools: ["read", "read"] })
  expectSchemaRejection({ ...base, allowedTools: ["a".repeat(65)] })
})

test("the declared schema itself rejects unresolved metadata and envelope violations", () => {
  const base = validRequest()
  expectSchemaRejection({
    ...base,
    execution: { ...base.execution, cwd: "src" },
  })
  expectSchemaRejection({
    ...base,
    execution: { ...base.execution, model: "" },
  })
  expectSchemaRejection({ ...base, budget: { ...base.budget, retries: 4 } })
  expectSchemaRejection({
    ...base,
    budget: { ...base.budget, tokenBudget: 3_999 },
  })
  expectSchemaRejection({ ...base, prompt: "a".repeat(20_001) })
  expectSchemaRejection({ ...base, unexpected: true })
})
