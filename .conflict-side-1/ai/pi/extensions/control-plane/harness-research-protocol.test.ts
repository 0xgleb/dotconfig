import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import {
  decodeHarnessResearchHandoff,
  decodeHarnessResearchPayload,
  harnessResearchHandoffMatchesAttempt,
  validateNewHarnessResearchPayload,
} from "./harness-research-protocol.ts"

const payload = {
  lane: "subscription-plan",
  harness: "claude-plan",
  profile: "research-config",
  project: "dotconfig",
  task: "subscription-harness-adversarial-review",
  repositoryRoot: "/Users/example/.config",
  isolation: "read-only",
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
  assert.equal(
    succeeds(
      decodeHarnessResearchPayload({ ...payload, prompt: "commit everything" }),
    ),
    false,
  )
  assert.equal(
    succeeds(
      decodeHarnessResearchPayload({ ...payload, repositoryRoot: "relative" }),
    ),
    false,
  )
  for (const repositoryRoot of ["/tmp/\u0000x", "/tmp/../x", "/tmp/x/"]) {
    assert.equal(
      succeeds(decodeHarnessResearchPayload({ ...payload, repositoryRoot })),
      false,
    )
  }
  assert.equal(
    succeeds(
      decodeHarnessResearchPayload({ ...payload, task: "task\ncommit" }),
    ),
    false,
  )
})

test("new research jobs require explicit non-spoofable ownership", () => {
  const projectOwned = {
    ...payload,
    ownership: {
      kind: "project-domain",
      project: "dotconfig",
      role: "dotconfig-research",
    },
    profile: "dotconfig-research",
  } as const
  assert.deepEqual(
    Effect.runSync(validateNewHarnessResearchPayload(projectOwned)),
    projectOwned,
  )
  assert.equal(
    succeeds(validateNewHarnessResearchPayload(payload)),
    false,
    "legacy payloads remain readable but cannot seed new jobs",
  )
  assert.equal(
    succeeds(
      validateNewHarnessResearchPayload({
        ...projectOwned,
        profile: "agentops-dotconfig",
        ownership: {
          kind: "project-domain",
          project: "dotconfig",
          role: "agentops-dotconfig",
        },
      }),
    ),
    false,
  )

  assert.equal(
    succeeds(
      validateNewHarnessResearchPayload({
        ...projectOwned,
        ownership: { ...projectOwned.ownership, project: "moneymentum" },
      }),
    ),
    false,
  )

  const agentopsOwned = {
    ...payload,
    profile: "agentops-dotconfig",
    ownership: {
      kind: "agentops-support",
      project: "dotconfig",
      role: "agentops-dotconfig",
      supportArea: "classifier",
    },
  } as const
  assert.deepEqual(
    Effect.runSync(validateNewHarnessResearchPayload(agentopsOwned)),
    agentopsOwned,
  )
  assert.equal(
    succeeds(
      validateNewHarnessResearchPayload({
        ...agentopsOwned,
        ownership: { ...agentopsOwned.ownership, role: "agentops-yielduck" },
      }),
    ),
    false,
  )
  assert.equal(
    succeeds(
      validateNewHarnessResearchPayload({
        ...agentopsOwned,
        ownership: { ...agentopsOwned.ownership, supportArea: "portfolio" },
      }),
    ),
    false,
  )
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
