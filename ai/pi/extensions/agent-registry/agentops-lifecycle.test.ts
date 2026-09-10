import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  AGENTOPS_INCIDENT_EVENT,
  agentTurnIncidentAfterRun,
  decodeAgentopsIncident,
  hasOpenAgentopsIncident,
  agentopsRequestText,
  isExplicitUserCancellation,
  shouldRouteToolFailureToAgentops,
} from "../shared/agentops-events.ts"

type Handler = (event: unknown, context: unknown) => unknown
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const handlerSource = (startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end)
}

const lifecycle = () => {
  const handlers = new Map<string, Handler[]>()
  const emitted: unknown[] = []
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    events: {
      emit: (name: string, payload: unknown) => {
        assert.equal(name, AGENTOPS_INCIDENT_EVENT)
        emitted.push(payload)
      },
    },
  }
  const install = new Function(
    "pi",
    "agentTurnIncidentAfterRun",
    "AGENTOPS_INCIDENT_EVENT",
    "isExplicitUserCancellation",
    "shouldRouteToolFailureToAgentops",
    `
    "use strict";
    let latestCtx = { active: true };
    let compactionInterruptionPending = false;
    let pendingAgentTurnIncident;
    let lifecycleEpoch = 1;
    let activeLifecycleEpoch = 1;
    let backlogCollectorAbort;
    let timer;
    let sessionPolicyDigest;
    let registryFailureActive;
    const STATUS_KEY = "registry";
    const store = { close: () => {} };
    ${handlerSource("const boundedIncidentSummary =", "const currentOwnerIntervention").replace("(content: unknown): string | undefined", "(content)")}
    ${handlerSource('  pi.on("tool_result"', '  pi.on("agent_end"')}
    ${handlerSource('  pi.on("agent_end"', "  const resolveRuntimeAgentId")}
    ${handlerSource('  pi.on("session_shutdown"', '  pi.registerCommand("agents"')}
    return () => latestCtx;
  `,
  )
  const currentContext: () => unknown = install(
    pi,
    agentTurnIncidentAfterRun,
    AGENTOPS_INCIDENT_EVENT,
    isExplicitUserCancellation,
    shouldRouteToolFailureToAgentops,
  )
  const context = { ui: { setStatus: () => {}, setWidget: () => {} } }
  return {
    dispatch: async (name: string, event: unknown) => {
      for (const handler of handlers.get(name) ?? [])
        await handler(event, context)
    },
    incidents: () => emitted,
    currentContext,
  }
}

const failure = {
  messages: [
    {
      role: "assistant",
      stopReason: "error",
      errorMessage:
        "You have hit your ChatGPT usage limit (pro plan). Try again in ~7257 min.",
    },
  ],
}

test("registry emits one provider incident only after the run settles", async () => {
  const runtime = lifecycle()
  await runtime.dispatch("agent_end", failure)
  assert.deepEqual(runtime.incidents(), [])
  await runtime.dispatch("agent_settled", {})
  assert.deepEqual(runtime.incidents(), [
    {
      severity: "warning",
      component: "provider",
      operation: "agent turn",
      summary: failure.messages[0]?.errorMessage,
    },
  ])
  await runtime.dispatch("agent_settled", {})
  assert.equal(runtime.incidents().length, 1)
})

test("a successful retry clears the earlier failure before settlement", async () => {
  const runtime = lifecycle()
  await runtime.dispatch("agent_end", failure)
  await runtime.dispatch("agent_end", {
    messages: [{ role: "assistant", stopReason: "stop" }],
  })
  await runtime.dispatch("agent_settled", {})
  assert.deepEqual(runtime.incidents(), [])
})

test("an assistant-free final run cannot replay an earlier failure", async () => {
  const runtime = lifecycle()
  await runtime.dispatch("agent_end", failure)
  await runtime.dispatch("agent_end", { messages: [] })
  await runtime.dispatch("agent_settled", {})
  assert.deepEqual(runtime.incidents(), [])
})

test("shutdown clears pending incidents before a late settlement", async () => {
  const runtime = lifecycle()
  await runtime.dispatch("agent_end", failure)
  await runtime.dispatch("session_shutdown", { reason: "reload" })
  await runtime.dispatch("agent_settled", {})
  assert.deepEqual(runtime.incidents(), [])
})

test("late agent-end cannot repopulate incidents after shutdown", async () => {
  const runtime = lifecycle()
  await runtime.dispatch("session_shutdown", { reason: "reload" })
  await runtime.dispatch("agent_end", failure)
  await runtime.dispatch("agent_settled", {})
  assert.deepEqual(runtime.incidents(), [])
})

test("late tool failures cannot emit from a retired registry lifecycle", async () => {
  const runtime = lifecycle()
  await runtime.dispatch("session_shutdown", { reason: "reload" })
  await runtime.dispatch("tool_result", {
    isError: true,
    toolName: "workflow",
    content: [
      {
        type: "text",
        text: "Classifier unavailable after two bounded attempts",
      },
    ],
  })
  assert.deepEqual(runtime.incidents(), [])
})

test("shutdown releases the context used by incident routing", async () => {
  const runtime = lifecycle()
  assert.notEqual(runtime.currentContext(), undefined)
  await runtime.dispatch("session_shutdown", { reason: "reload" })
  assert.equal(runtime.currentContext(), undefined)
})

test("incident routing stops when shutdown occurs during its snapshot read", async () => {
  const snapshot = Promise.withResolvers<{ requests: never[] }>()
  const enqueued: unknown[] = []
  const install = new Function(
    "snapshot",
    "enqueued",
    "decodeAgentopsIncident",
    "isExplicitUserCancellation",
    "hasOpenAgentopsIncident",
    "agentopsRequestText",
    `
    "use strict";
    let activeLifecycleEpoch = 1;
    let latestCtx = { cwd: "/workspace", sessionManager: { getSessionId: () => "test" } };
    const pi = { getSessionName: () => "test" };
    const run = value => value;
    const store = { snapshot: () => snapshot, enqueue: value => { enqueued.push(value); } };
    const join = (...parts) => parts.join("/");
    const homedir = () => "/home";
    ${handlerSource("  const routeAgentopsIncident =", "  pi.events.on(AGENTOPS_INCIDENT_EVENT").replace("(payload: unknown): Promise<void>", "(payload)")}
    return { route: routeAgentopsIncident, retire: () => { activeLifecycleEpoch = undefined; latestCtx = undefined; } };
  `,
  )
  const runtime: {
    route: (payload: unknown) => Promise<void>
    retire: () => void
  } = install(
    snapshot.promise,
    enqueued,
    decodeAgentopsIncident,
    isExplicitUserCancellation,
    hasOpenAgentopsIncident,
    agentopsRequestText,
  )
  const pending = runtime.route({
    severity: "error",
    component: "workflow",
    operation: "run",
    summary: "Classifier unavailable",
  })
  runtime.retire()
  snapshot.resolve({ requests: [] })
  await pending
  assert.deepEqual(enqueued, [])
})
