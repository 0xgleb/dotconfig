import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { Effect, Either } from "effect"
import { decodeStoredJob } from "../job-runtime.ts"
import {
  ALLOWANCE_POOLS,
  isAllowancePool,
  isAllowanceSource,
} from "../allowance-pool.ts"
import { isAllowanceRemainingPercent } from "../usage-policy.ts"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
const start = source.indexOf("type JobState =")
const end = source.indexOf("const fetchJson =", start)
assert.ok(start >= 0 && end > start)
const install = new Function(
  "ALLOWANCE_POOLS",
  "isAllowancePool",
  "isAllowanceSource",
  "isAllowanceRemainingPercent",
  "Effect",
  "Either",
  "decodeStoredJob",
  `${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })}\nreturn { decodeUsage, decodeAgents };`,
)
const decoders: unknown = install(
  ALLOWANCE_POOLS,
  isAllowancePool,
  isAllowanceSource,
  isAllowanceRemainingPercent,
  Effect,
  Either,
  decodeStoredJob,
)
assert.ok(record(decoders))
const decodeUsage = decoders.decodeUsage
const decodeAgents = decoders.decodeAgents
assert.ok(typeof decodeUsage === "function")
assert.ok(typeof decodeAgents === "function")

const sample = {
  provider: "openai",
  pool: "chatgpt-shared-weekly",
  source: "manual",
  capturedAt: 1_000,
  remainingPercent: 20,
  resetAt: 9_000,
}
const usage = (checkpoint: unknown, source = "manual") => ({
  samples: [],
  checkpoints: [checkpoint],
  control: { provider: "openai", pool: "chatgpt-shared-weekly", source },
  sampling: { status: "ok", lastAttemptAt: 1_000, lastCapturedAt: 1_000 },
})
const decode = (input: unknown): unknown =>
  Reflect.apply(decodeUsage, undefined, [input])

const agent = {
  id: "agent-fixture",
  presence: "runtime",
  label: "Worker",
  cwd: "/project",
  model: "provider/model",
  heartbeatAt: 1_000,
  expiresAt: 2_000,
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
  activities: [{ todoId: 1, status: "pending", text: "Fixture" }],
  roles: [{ project: "/project", role: "worker", mode: "operational" }],
}

test("dashboard decodes resetless refills without losing precision or inventing reset timestamps", () => {
  const refill = {
    provider: sample.provider,
    pool: sample.pool,
    source: sample.source,
    capturedAt: 2_000,
    remainingPercent: 150.125,
    event: "refill",
  }
  assert.deepEqual(decode(usage(refill)), usage(refill))
})

test("dashboard rejects contradictory or unknown checkpoint event envelopes atomically", () => {
  for (const checkpoint of [
    { ...sample, event: "refill" },
    { ...sample, event: "unknown-event" },
    { ...sample, provider: "unknown-provider" },
    { ...sample, pool: "session" },
    { ...sample, remainingPercent: 201 },
    { ...sample, remainingPercent: "20" },
    { ...sample, resetAt: sample.capturedAt },
  ])
    assert.equal(decode(usage(checkpoint)), undefined)
})

test("dashboard accepts the exported allowance sources and provider-pool pairs", () => {
  for (const source of [
    "manual",
    "estimated-history",
    "codex-app-server",
    "claude-statusline",
    "legacy-import",
    "unavailable",
  ]) {
    assert.deepEqual(decode(usage(sample, source)), usage(sample, source))
  }
  for (const { provider, pool } of ALLOWANCE_POOLS) {
    const checkpoint = { ...sample, provider, pool }
    assert.deepEqual(decode(usage(checkpoint)), usage(checkpoint))
  }
})

test("dashboard rejects malformed sampling timestamps without coercion", () => {
  const valid = usage(sample)
  for (const sampling of [
    { status: "unknown" },
    { status: "ok", lastAttemptAt: "1000" },
    { status: "ok", lastCapturedAt: 0.5 },
    { status: "ok", error: "unknown" },
  ])
    assert.equal(decode({ ...valid, sampling }), undefined)
  assert.deepEqual(decode({ ...valid, sampling: { status: "unavailable" } }), {
    ...valid,
    sampling: { status: "unavailable" },
  })
})

test("dashboard reconstructs validated agent presence and rejects malformed nested records", () => {
  assert.deepEqual(
    Reflect.apply(decodeAgents, undefined, [{ agents: [agent] }]),
    [agent],
  )
  for (const malformed of [
    { ...agent, usage: { ...agent.usage, totalTokens: "10" } },
    { ...agent, usage: { ...agent.usage, input: 0.5 } },
    {
      ...agent,
      activities: [{ todoId: 1, status: "unknown", text: "Fixture" }],
    },
    {
      ...agent,
      roles: [{ project: "/project", role: "worker", mode: "unknown" }],
    },
  ])
    assert.equal(
      Reflect.apply(decodeAgents, undefined, [{ agents: [agent, malformed] }]),
      undefined,
    )
})
