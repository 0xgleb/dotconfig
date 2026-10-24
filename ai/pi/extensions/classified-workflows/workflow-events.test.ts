import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { WorkflowScriptError } from "./core.ts"
import { applyQuestionResolutionSnapshot } from "./intent-context.ts"
import {
  QUESTION_STATE_EVENT,
  QUESTION_RESOLVED_EVENT,
} from "../shared/question-events.ts"
import { MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT } from "../shared/registry-intent-events.ts"
import { REMOTE_CAPABILITY_HANDSHAKE_EVENT } from "../shared/remote-capability.ts"
import { AGENTOPS_INCIDENT_EVENT } from "../shared/agentops-events.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const harness = () => {
  const start = source.indexOf("  const validWorkflowQuestionId =")
  const end = source.indexOf('  pi.on("agent_start",', start)
  assert.ok(start >= 0 && end > start)
  const listeners = new Map<string, (value: unknown) => void>()
  const failures: unknown[] = []
  const initial = {
    questions: [{ id: 1, question: "Continue?", status: "pending" }],
  }
  const pi = {
    events: {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, listener)
      },
      emit: (_name: string, value: unknown) => {
        failures.push(value)
      },
    },
  }
  const inspect: () => { state: unknown; paused: boolean; circuit: unknown } =
    new Function(
      "pi",
      "initial",
      "applyQuestionResolutionSnapshot",
      "WorkflowScriptError",
      "QUESTION_STATE_EVENT",
      "QUESTION_RESOLVED_EVENT",
      "MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT",
      "REMOTE_CAPABILITY_HANDSHAKE_EVENT",
      "AGENTOPS_INCIDENT_EVENT",
      "isRecord",
      `let questionState = initial;
     let continuationPaused = true;
     let skipNextCapabilityOutcome = false;
     let circuit = { open: true };
     const latestCtx = {};
     const setContinuationPaused = value => { continuationPaused = value };
     const setCapabilityCircuit = value => { circuit = value };
     ${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })}
     return () => ({ state: questionState, paused: continuationPaused, circuit });`,
    )(
      pi,
      initial,
      applyQuestionResolutionSnapshot,
      WorkflowScriptError,
      QUESTION_STATE_EVENT,
      QUESTION_RESOLVED_EVENT,
      MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT,
      REMOTE_CAPABILITY_HANDSHAKE_EVENT,
      AGENTOPS_INCIDENT_EVENT,
      (value: unknown) =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    )
  return { listeners, failures, inspect, initial }
}

test("malformed question snapshots do not replace classifier state", () => {
  for (const value of [
    undefined,
    null,
    {},
    { questions: null },
    { questions: [{ id: 1, status: "resolved", question: "Q" }] },
    {
      questions: [
        { id: 1, status: "pending", question: "Q", header: undefined },
      ],
    },
    {
      questions: [
        { id: 1, status: "pending", question: "Q", options: undefined },
      ],
    },
    {
      questions: [
        {
          id: 1,
          status: "pending",
          question: "Q",
          options: [{ label: "Yes", description: undefined }],
        },
      ],
    },
  ]) {
    const state = harness()
    assert.doesNotThrow(() =>
      state.listeners.get(QUESTION_STATE_EVENT)?.(value),
    )
    assert.deepEqual(state.inspect().state, state.initial)
    assert.equal(state.failures.length, 1)
  }
})

test("malformed resolutions do not resume paused work", () => {
  for (const value of [
    undefined,
    null,
    { id: 1, answer: 7 },
    { id: 0, answer: "yes" },
  ]) {
    const state = harness()
    assert.doesNotThrow(() =>
      state.listeners.get(QUESTION_RESOLVED_EVENT)?.(value),
    )
    assert.equal(state.inspect().paused, true)
    assert.deepEqual(state.inspect().state, state.initial)
    assert.equal(state.failures.length, 1)
  }
})

test("malformed capability handshakes do not reopen the circuit", () => {
  for (const value of [
    undefined,
    null,
    { status: "invented" },
    {
      status: "restored",
      recoveryAttempts: 0,
      expectedTools: [],
      activeTools: [7],
    },
  ]) {
    const state = harness()
    assert.doesNotThrow(() =>
      state.listeners.get(REMOTE_CAPABILITY_HANDSHAKE_EVENT)?.(value),
    )
    assert.deepEqual(state.inspect().circuit, { open: true })
    assert.equal(state.failures.length, 1)
  }
})

test("valid question and capability events preserve their existing transitions", () => {
  const state = harness()
  state.listeners.get(QUESTION_STATE_EVENT)?.(state.initial)
  state.listeners.get(QUESTION_RESOLVED_EVENT)?.({ id: 1, answer: "yes" })
  assert.deepEqual(state.inspect().state, {
    questions: [
      { id: 1, question: "Continue?", status: "resolved", answer: "yes" },
    ],
  })
  assert.equal(state.inspect().paused, false)
  state.listeners.get(REMOTE_CAPABILITY_HANDSHAKE_EVENT)?.({
    status: "restored",
    recoveryAttempts: 0,
    expectedTools: ["read"],
    activeTools: ["read"],
  })
  assert.equal((state.inspect().circuit as { open: boolean }).open, false)
  assert.equal(state.failures.length, 0)
})
