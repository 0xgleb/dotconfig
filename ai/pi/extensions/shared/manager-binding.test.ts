import assert from "node:assert/strict"
import test from "node:test"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { getManagerBinding, registerManagerBinding } from "./manager-binding.ts"

const fixture = (marked = false) => {
  const handlers = new Map<string, Set<(value: unknown) => void>>()
  const values = new Map([["manager-worker", "worker-123"]])
  const api = (registered: readonly string[]) =>
    ({
      getFlag: (name: string) =>
        registered.includes(name) ? values.get(name) : undefined,
      events: {
        emit: (name: string, value: unknown) => {
          for (const handler of handlers.get(name) ?? []) handler(value)
        },
        on: (name: string, handler: (value: unknown) => void) => {
          const listeners = handlers.get(name) ?? new Set()
          listeners.add(handler)
          handlers.set(name, listeners)
          return () => listeners.delete(handler)
        },
      },
    }) as unknown as ExtensionAPI
  const ctx = {
    sessionManager: {
      getSessionId: () => "manager-session",
      getBranch: () =>
        marked
          ? [
              {
                type: "message",
                message: {
                  role: "custom",
                  customType: "manager-worker-observation",
                },
              },
            ]
          : [],
    },
  } as unknown as ExtensionContext
  return { owner: api(["manager-worker"]), todo: api([]), ctx }
}

test("manager binding crosses extension-private flag APIs without reading another extension's flags", () => {
  const f = fixture()
  assert.equal(f.owner.getFlag("manager-worker"), "worker-123")
  assert.equal(f.todo.getFlag("manager-worker"), undefined)
  registerManagerBinding(f.owner, sessionId => {
    assert.equal(sessionId, "manager-session")
    const workerSessionId = f.owner.getFlag("manager-worker")
    return typeof workerSessionId === "string"
      ? { role: "manager", workerSessionId }
      : undefined
  })
  assert.deepEqual(
    getManagerBinding(f.todo, f.ctx),
    Either.right({ role: "manager", workerSessionId: "worker-123" }),
  )
})

test("normal standalone task use remains local when no manager controller is installed", () => {
  const f = fixture()
  assert.deepEqual(
    getManagerBinding(f.todo, f.ctx),
    Either.right({ role: "worker" }),
  )
})

test("a known manager conversation with an unavailable binding cannot fall through to an empty local backlog", () => {
  const f = fixture(true)
  assert.ok(Either.isLeft(getManagerBinding(f.todo, f.ctx)))
})
