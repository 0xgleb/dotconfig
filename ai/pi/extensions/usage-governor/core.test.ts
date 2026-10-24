import assert from "node:assert/strict"
import test from "node:test"
import {
  autonomousRoleForCwd,
  controlPlaneUsageAdmissionUrl,
  controlPlaneUsageControlUrl,
  controlPlaneUsageUrl,
  emptyTurnLaneState,
  manualAllowanceCheckpointRequest,
  markHumanFollowUp,
  markResponsiveAutonomousTurn,
  parseAllowanceCheckpointInput,
  parseAutonomousAdmission,
  parsePersistedModelRef,
  preferredModelRestoration,
  recordInputLane,
  takeTurnLane,
  turnLaneForInput,
} from "./core.ts"

test("preferred-model restoration cannot deadlock an already usable active model", () => {
  assert.deepEqual(
    preferredModelRestoration(
      { provider: "openai-codex", id: "gpt-5.6-sol", thinking: "high" },
      { provider: "openai-codex", id: "gpt-5.6-sol", thinking: "xhigh" },
      true,
    ),
    { action: "set-thinking", thinking: "xhigh" },
  )
  assert.deepEqual(
    preferredModelRestoration(
      { provider: "openai-codex", id: "gpt-5.6-sol", thinking: "high" },
      { provider: "retired-provider", id: "retired-model", thinking: "xhigh" },
      false,
    ),
    { action: "use-active-model" },
  )
})

test("only genuine host inputs open the subscription lane", () => {
  assert.equal(turnLaneForInput("interactive"), "human")
  assert.equal(turnLaneForInput("rpc"), "human")
  assert.equal(turnLaneForInput("extension"), "autonomous")
})

test("human follow-ups are correlated to their exact turn", () => {
  let state = markHumanFollowUp(emptyTurnLaneState(), "human follow-up", 0)
  state = recordInputLane(
    state,
    { source: "extension", text: "autonomous reminder" },
    0,
  )
  state = recordInputLane(
    state,
    { source: "extension", text: "human follow-up" },
    0,
  )

  const autonomous = takeTurnLane(state, "autonomous reminder")
  assert.equal(autonomous.lane, "autonomous")
  const human = takeTurnLane(autonomous.state, "human follow-up")
  assert.equal(human.lane, "human")
  assert.deepEqual(human.state, emptyTurnLaneState())
})

test("a reviewed operational wake is responsive without impersonating a human turn", () => {
  const marked = markResponsiveAutonomousTurn(
    emptyTurnLaneState(),
    "operational triage",
  )
  const turn = takeTurnLane(marked, "operational triage")
  assert.equal(turn.lane, "responsive")
  assert.deepEqual(turn.state, emptyTurnLaneState())
})

test("an uncorrelated human event cannot open an autonomous turn", () => {
  const marked = markHumanFollowUp(emptyTurnLaneState(), "different prompt", 0)
  const recorded = recordInputLane(
    marked,
    { source: "extension", text: "autonomous reminder" },
    0,
  )
  assert.equal(takeTurnLane(recorded, "autonomous reminder").lane, "autonomous")
})

test("stale human markers expire instead of opening a later matching turn", () => {
  const marked = markHumanFollowUp(emptyTurnLaneState(), "same prompt", 0)
  const recorded = recordInputLane(
    marked,
    { source: "extension", text: "same prompt" },
    5_001,
  )
  assert.equal(takeTurnLane(recorded, "same prompt").lane, "autonomous")
})

test("allowance command input requires bounded percentages and zoned timestamps", () => {
  assert.deepEqual(
    parseAllowanceCheckpointInput(
      "65 2026-08-15T03:16:00-03:00 2026-08-08T16:27:00-03:00",
    ),
    {
      capturedAt: 1_786_217_220_000,
      remainingPercent: 65,
      resetAt: 1_786_774_560_000,
    },
  )
  assert.deepEqual(
    parseAllowanceCheckpointInput("65.25 2026-08-15T03:16:00-03:00", 1_000),
    {
      capturedAt: 1_000,
      remainingPercent: 65.25,
      resetAt: 1_786_774_560_000,
    },
  )
  assert.deepEqual(
    parseAllowanceCheckpointInput("113 2026-08-15T03:16:00-03:00", 1_000),
    {
      capturedAt: 1_000,
      remainingPercent: 113,
      resetAt: 1_786_774_560_000,
    },
  )
  assert.equal(
    parseAllowanceCheckpointInput("201 2026-08-15T03:16:00-03:00", 1_000),
    undefined,
  )
  assert.equal(
    parseAllowanceCheckpointInput("65 2026-08-15T03:16:00", 1_000),
    undefined,
  )
  assert.deepEqual(
    parseAllowanceCheckpointInput("100 refill 2026-08-14T22:46:00-03:00"),
    {
      capturedAt: 1_786_758_360_000,
      event: "refill",
      remainingPercent: 100,
    },
  )
})

test("manual allowance checkpoints identify the governed provider pool", () => {
  assert.deepEqual(
    manualAllowanceCheckpointRequest({
      capturedAt: 1_786_639_320_000,
      remainingPercent: 96,
      resetAt: 1_787_205_360_000,
    }),
    {
      provider: "openai",
      pool: "chatgpt-shared-weekly",
      source: "manual",
      capturedAt: 1_786_639_320_000,
      remainingPercent: 96,
      resetAt: 1_787_205_360_000,
    },
  )
  assert.deepEqual(
    manualAllowanceCheckpointRequest(
      {
        capturedAt: 1_786_639_320_000,
        remainingPercent: 113,
        resetAt: 1_787_205_360_000,
      },
      "codex-app-server-weekly",
    ),
    {
      provider: "openai",
      pool: "codex-app-server-weekly",
      source: "manual",
      capturedAt: 1_786_639_320_000,
      remainingPercent: 113,
      resetAt: 1_787_205_360_000,
    },
  )
})

test("control-plane usage URLs remain loopback-only", () => {
  assert.equal(
    controlPlaneUsageUrl(undefined),
    "http://127.0.0.1:43121/v1/usage",
  )
  assert.equal(
    controlPlaneUsageControlUrl(undefined),
    "http://127.0.0.1:43121/v1/usage/control",
  )
  assert.equal(
    controlPlaneUsageAdmissionUrl(undefined, "moneymentum-operator"),
    "http://127.0.0.1:43121/v1/usage/admit?role=moneymentum-operator",
  )
  assert.equal(
    controlPlaneUsageAdmissionUrl(undefined, "reviewer", {
      kind: "workflow",
      requestedTokens: 800_000,
    }),
    "http://127.0.0.1:43121/v1/usage/admit?role=reviewer&kind=workflow&requestedTokens=800000",
  )
  assert.equal(
    controlPlaneUsageAdmissionUrl("44000", "reviewer"),
    "http://127.0.0.1:44000/v1/usage/admit?role=reviewer",
  )
  assert.equal(controlPlaneUsageAdmissionUrl("0", "general"), undefined)
  assert.equal(
    controlPlaneUsageAdmissionUrl("43121/path", "general"),
    undefined,
  )
  assert.equal(controlPlaneUsageAdmissionUrl(undefined, "bad role"), undefined)
  assert.equal(
    controlPlaneUsageAdmissionUrl(undefined, "reviewer", {
      kind: "workflow",
      requestedTokens: 3_999,
    }),
    undefined,
  )
  assert.equal(controlPlaneUsageUrl("43121/path"), undefined)
})

test("project paths map to bounded autonomous roles", () => {
  assert.equal(
    autonomousRoleForCwd(
      "/Users/example/code/dataclique/yielduck",
      "/Users/example",
    ),
    "yielduck-operator",
  )
  assert.equal(
    autonomousRoleForCwd("/Users/example/code/st0x", "/Users/example"),
    "reviewer",
  )
  assert.equal(autonomousRoleForCwd("/tmp/project", undefined), "general")
})

test("autonomous admission responses reject malformed policy state", () => {
  assert.deepEqual(
    parseAutonomousAdmission({
      admission: {
        allowed: true,
        grantedTokens: 320_000,
        policy: { pace: "critical", throttleRatio: 0.2 },
      },
    }),
    {
      allowed: true,
      pace: "critical",
      throttleRatio: 0.2,
      grantedTokens: 320_000,
    },
  )
  assert.deepEqual(
    parseAutonomousAdmission({
      admission: {
        allowed: false,
        retryAt: 12_000,
        grantedTokens: 0,
        policy: { pace: "critical", throttleRatio: 0.2 },
      },
    }),
    {
      allowed: false,
      pace: "critical",
      throttleRatio: 0.2,
      retryAt: 12_000,
      grantedTokens: 0,
    },
  )
  assert.equal(
    parseAutonomousAdmission({
      admission: {
        allowed: false,
        policy: { pace: "critical", throttleRatio: 0.2 },
      },
    }),
    undefined,
  )
  assert.equal(
    parseAutonomousAdmission({
      admission: { allowed: true, policy: { pace: "open" } },
    }),
    undefined,
  )
})

test("persisted preferred models reject malformed state", () => {
  assert.deepEqual(
    parsePersistedModelRef({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      thinking: "xhigh",
    }),
    {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      thinking: "xhigh",
    },
  )
  assert.equal(parsePersistedModelRef({ provider: "", id: "model" }), undefined)
  assert.equal(parsePersistedModelRef(null), undefined)
  assert.equal(
    parsePersistedModelRef({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      thinking: "extreme",
    }),
    undefined,
  )
})
