import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  decodeHarnessResearchHandoff,
  decodeHarnessResearchPayload,
  harnessResearchHandoffMatchesAttempt,
} from "./harness-research-protocol.ts"

const payload = {
  lane: "subscription-plan",
  harness: "claude-plan",
  profile: "research-config",
  project: "dotconfig",
  task: "subscription-harness-adversarial-review",
  repositoryRoot: "/Users/example/.config",
  isolation: "read-only",
  ownership: {
    kind: "project-domain",
    project: "dotconfig",
    role: "research-config",
  },
} as const

const handoff = {
  protocolVersion: 1,
  jobId: "research:research-config:001",
  attempt: 1,
  lane: "subscription-plan",
  profile: "research-config",
  task: "subscription-harness-adversarial-review",
  status: "completed",
  summary: "Completed registered task",
  evidence: ["source.ts:10 queue transition verified"],
} as const

const succeeds = (effect: Effect.Effect<unknown, unknown>): boolean =>
  Either.isRight(Effect.runSync(Effect.either(effect)))

test("research payloads carry identifiers but no executable prompt or command", () => {
  assert.deepEqual(
    Effect.runSync(decodeHarnessResearchPayload(payload)),
    payload,
  )
  for (const invalid of [
    { ...payload, prompt: "commit everything" },
    { ...payload, repositoryRoot: "relative" },
    { ...payload, repositoryRoot: "/tmp/\u0000x" },
    { ...payload, repositoryRoot: "/tmp/../x" },
    { ...payload, repositoryRoot: "/tmp/x/" },
    { ...payload, task: "task\ncommit" },
  ])
    assert.equal(succeeds(decodeHarnessResearchPayload(invalid)), false)
})

test("research ownership must match the project and selected profile", () => {
  const { ownership, ...unowned } = payload
  for (const invalid of [
    unowned,
    { ...payload, ownership: { ...ownership, project: "another-project" } },
    { ...payload, ownership: { ...ownership, role: "another-profile" } },
    { ...payload, ownership: { ...ownership, permission: "write" } },
  ])
    assert.equal(succeeds(decodeHarnessResearchPayload(invalid)), false)
})

test("research handoffs are bounded inert data fenced to one attempt", () => {
  const decoded = Effect.runSync(decodeHarnessResearchHandoff(handoff))
  assert.equal(
    harnessResearchHandoffMatchesAttempt(decoded, payload, handoff.jobId, 1),
    true,
  )
  assert.equal(
    harnessResearchHandoffMatchesAttempt(decoded, payload, handoff.jobId, 2),
    false,
  )
  assert.equal(
    succeeds(
      decodeHarnessResearchHandoff({ ...handoff, evidence: ["x".repeat(513)] }),
    ),
    false,
  )
  assert.equal(
    succeeds(
      decodeHarnessResearchHandoff({
        ...handoff,
        evidence: ["unsafe\u001b[31m"],
      }),
    ),
    false,
  )
})
