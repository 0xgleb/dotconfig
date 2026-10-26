import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { Effect } from "effect"

import { REGISTRY_OUTCOME_EVENT } from "../shared/registry-intent-events.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const outcome = async (ownership: "owned" | "unowned") => {
  const start = source.indexOf("  pi.events.on(REGISTRY_OUTCOME_EVENT,")
  const end = source.indexOf(
    "  pi.events.on(REGISTRY_PROJECTS_REQUEST_EVENT,",
    start,
  )
  assert.ok(start >= 0 && end > start)
  const mutations: string[] = []
  const target = {
    id: "12345678-1234-1234-1234-123456789001",
    project: "/fixture/project",
    role: "developer",
    status: "queued",
  }
  const lease = {
    id: "lease-1",
    project: target.project,
    role: target.role,
    owner: { id: "agent-1" },
    status: "active",
  }
  let listener: ((payload: unknown) => void) | undefined
  const mutate = (name: string, value: unknown) => {
    mutations.push(name)
    return Effect.succeed(value)
  }
  const bindings = {
    REGISTRY_OUTCOME_EVENT,
    latestCtx: {},
    identity: () => ({ id: "agent-1" }),
    run: Effect.runPromise,
    sync: async () => undefined,
    store: {
      snapshot: () =>
        Effect.succeed({
          requests: [target],
          leases: ownership === "owned" ? [lease] : [],
        }),
      claim: () => mutate("claim", { lease }),
      claimRequest: () => mutate("claimRequest", target),
      completeRequest: () => mutate("completeRequest", target),
      failRequest: () => mutate("failRequest", target),
    },
    pi: {
      events: {
        on: (_name: string, handler: (payload: unknown) => void) => {
          listener = handler
        },
      },
    },
  }
  new Function(
    ...Object.keys(bindings),
    stripTypeScriptTypes(source.slice(start, end), { mode: "strip" }),
  )(...Object.values(bindings))
  const handle = listener
  assert.ok(handle)
  const result = await new Promise<unknown>(resolve =>
    handle({
      requestId: "12345678",
      resolution: "completed",
      summary: "Completed assigned implementation",
      report: resolve,
    }),
  )
  return { result, mutations }
}

test(
  "outcome recording requires an active explicitly owned role",
  { timeout: 1_000 },
  async () => {
    const recorded = await outcome("unowned")
    assert.deepEqual(recorded, {
      result: {
        outcome: "failed",
        reason: "request role must be claimed explicitly",
      },
      mutations: [],
    })
  },
)

test(
  "an owned request outcome records against its existing lease",
  { timeout: 1_000 },
  async () => {
    assert.deepEqual(await outcome("owned"), {
      result: { outcome: "recorded" },
      mutations: ["claimRequest", "completeRequest"],
    })
  },
)
