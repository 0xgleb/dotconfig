import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import type { AgentRequest, WorkflowLimits } from "./core.ts"
import {
  WORKFLOW_RUNTIME_ENTRY,
  emptyWorkflowRuntimeState,
  finishWorkflowRun,
  markWorkflowRunRecovered,
  readOnlyRecoveryRequest as readOnlyRecoveryRequestEffect,
  recoverableWorkflowRuns,
  restoreWorkflowRuntimeState,
  startWorkflowRun,
} from "./workflow-runtime-state.ts"

const readOnlyRecoveryRequest = (request: AgentRequest): AgentRequest =>
  Effect.runSync(readOnlyRecoveryRequestEffect(request))

const limits: WorkflowLimits = {
  maxAgents: 1,
  concurrency: 1,
  agentTimeoutMs: 300_000,
  workflowTimeoutMs: 360_000,
  retries: 0,
  tokenBudget: 16_000,
}

const runningState = () =>
  startWorkflowRun(emptyWorkflowRuntimeState, {
    id: "wf-7",
    label: "Inspect recovery",
    code: 'return await agent("inspect")',
    limits,
    startedAt: 100,
  })

test("a running workflow is persisted as one bounded recoverable attempt", () => {
  const state = runningState()
  assert.deepEqual(recoverableWorkflowRuns(state), [
    {
      id: "wf-7",
      label: "Inspect recovery",
      code: 'return await agent("inspect")',
      limits,
      startedAt: 100,
      updatedAt: 100,
      status: "running",
      recoveryCount: 0,
    },
  ])
})

test("terminal transitions prevent a completed or cancelled workflow from replaying", () => {
  const completed = finishWorkflowRun(runningState(), "wf-7", "completed", 200)
  const cancelled = finishWorkflowRun(runningState(), "wf-7", "cancelled", 201)
  assert.deepEqual(recoverableWorkflowRuns(completed), [])
  assert.deepEqual(recoverableWorkflowRuns(cancelled), [])
})

test("recovery is bounded across repeated process failures", () => {
  const first = markWorkflowRunRecovered(runningState(), "wf-7", 110)
  const second = markWorkflowRunRecovered(first, "wf-7", 120)
  const third = markWorkflowRunRecovered(second, "wf-7", 130)
  assert.equal(first.runs[0]?.recoveryCount, 1)
  assert.equal(second.runs[0]?.recoveryCount, 2)
  assert.equal(third.runs[0]?.recoveryCount, 3)
  assert.deepEqual(recoverableWorkflowRuns(third), [])
})

test("the latest malformed snapshot fails closed instead of resurrecting an older running attempt", () => {
  const restored = restoreWorkflowRuntimeState([
    {
      type: "custom",
      customType: WORKFLOW_RUNTIME_ENTRY,
      data: runningState(),
    },
    {
      type: "custom",
      customType: WORKFLOW_RUNTIME_ENTRY,
      data: { runs: [{ id: "wf-7", status: "running" }] },
    },
  ])
  assert.deepEqual(restored, emptyWorkflowRuntimeState)
})

test("recovered attempts allow only read-only child tools", () => {
  const implicitReadOnly: AgentRequest = { task: "inspect" }
  const explicitReadOnly: AgentRequest = {
    task: "inspect",
    tools: ["read", "grep", "find", "ls"],
  }
  assert.deepEqual(readOnlyRecoveryRequest(implicitReadOnly), implicitReadOnly)
  assert.deepEqual(readOnlyRecoveryRequest(explicitReadOnly), explicitReadOnly)
  assert.throws(
    () => readOnlyRecoveryRequest({ task: "change", tools: ["read", "edit"] }),
    /cannot replay mutation-capable child tools/i,
  )
  assert.throws(
    () => readOnlyRecoveryRequest({ task: "probe", tools: ["bash"] }),
    /cannot replay mutation-capable child tools/i,
  )
})
