import assert from "node:assert/strict"
import test from "node:test"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import {
  decodeTodoControl,
  registerTodoControl,
  requestTodoControl,
  todoPriorityAvailable,
} from "./control.ts"

const fixture = () => {
  const listeners = new Map<string, Set<(value: unknown) => void>>()

  const pi = {
    events: {
      on: (name: string, handler: (value: unknown) => void) => {
        const handlers = listeners.get(name) ?? new Set()
        handlers.add(handler)
        listeners.set(name, handlers)

        return () => handlers.delete(handler)
      },
      emit: (name: string, value: unknown) => {
        for (const handler of listeners.get(name) ?? []) handler(value)
      },
    },
  } as unknown as ExtensionAPI

  const ctx = {
    cwd: "/projects/worker",
    sessionManager: { getSessionId: () => "worker" },
  } as unknown as ExtensionContext

  return { pi, ctx }
}

test("manager todo requests decode the existing task operations without inventing another action language", () => {
  assert.deepEqual(
    decodeTodoControl({ action: "add", text: "Concrete task", parentId: 2 }),
    Either.right({ action: "add", text: "Concrete task", parentId: 2 }),
  )
  assert.ok(
    Either.isLeft(
      decodeTodoControl({ action: "execute", command: "arbitrary" }),
    ),
  )
  assert.ok(
    Either.isLeft(
      decodeTodoControl({ action: "list", command: "extra control" }),
    ),
  )
})

test("priority control strictly authenticates a rank or explicit unassignment", () => {
  for (const priority of [1, Number.MAX_SAFE_INTEGER, null])
    assert.deepEqual(
      decodeTodoControl({ action: "priority", id: 2, priority }),
      Either.right({ action: "priority", id: 2, priority }),
    )

  for (const request of [
    { action: "priority", id: 2 },
    { action: "priority", priority: 1 },
    ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"].map(
      priority => ({ action: "priority", id: 2, priority }),
    ),
    { action: "priority", id: 2, priority: 1, status: "pending" },
  ])
    assert.ok(
      Either.isLeft(decodeTodoControl(request)),
      JSON.stringify(request),
    )
})

for (const request of [
  { action: "priority", id: 1, priority: 2 },
  { action: "priority_relative", id: 1, referenceId: 2, position: "above" },
  { action: "priority_order", ids: [2, 1] },
] as const) {
  test(`older task handlers cannot receive speculative priority mutations (${request.action})`, () => {
    const f = fixture()
    let calls = 0

    registerTodoControl(f.pi, () => {
      calls += 1

      return { isError: false, message: "legacy" }
    })

    assert.equal(todoPriorityAvailable(f.pi), false)

    const result = requestTodoControl(f.pi, f.ctx, request)

    assert.ok(Either.isLeft(result))
    assert.equal(result.left._tag, "TodoControlError")
    assert.equal(result.left.message, "The worker task handler is unavailable.")
    assert.equal(calls, 0)
  })

  test(`priority capability selects one capable handler and fails closed after release (${request.action})`, () => {
    const f = fixture()
    let calls = 0

    registerTodoControl(f.pi, () =>
      assert.fail("priority reached legacy reload handler"),
    )

    const release = registerTodoControl(
      f.pi,
      (received, ctx) => {
        calls += 1
        assert.equal(ctx, f.ctx)
        assert.deepEqual(received, request)

        return { isError: false, message: "saved priority" }
      },
      { priority: true },
    )

    assert.equal(todoPriorityAvailable(f.pi), true)
    assert.deepEqual(
      requestTodoControl(f.pi, f.ctx, request),
      Either.right({ isError: false, message: "saved priority" }),
    )
    assert.equal(calls, 1)

    release()

    assert.equal(todoPriorityAvailable(f.pi), false)

    const unavailable = requestTodoControl(f.pi, f.ctx, request)

    assert.ok(Either.isLeft(unavailable))
    assert.equal(unavailable.left._tag, "TodoControlError")
    assert.equal(
      unavailable.left.message,
      "The worker task handler is unavailable.",
    )
    assert.equal(calls, 1)
  })
}

test("overlap routes status changes through the priority-aware writer so legacy state cannot erase metadata", () => {
  const f = fixture()

  registerTodoControl(f.pi, () =>
    assert.fail("legacy writer would erase priority metadata"),
  )

  registerTodoControl(
    f.pi,
    request => {
      assert.deepEqual(request, {
        action: "status",
        id: 1,
        status: "completed",
      })

      return { isError: false, message: "preserved priority" }
    },
    { priority: true },
  )

  assert.deepEqual(
    requestTodoControl(f.pi, f.ctx, {
      action: "status",
      id: 1,
      status: "completed",
    }),
    Either.right({ isError: false, message: "preserved priority" }),
  )
})

test("priority-only handlers cannot receive effort changes or estimated additions", () => {
  const f = fixture()
  let calls = 0

  registerTodoControl(
    f.pi,
    () => {
      calls += 1

      return { isError: false, message: "legacy priority writer" }
    },
    { priority: true },
  )

  for (const request of [
    { action: "effort", id: 1, effort: 3 } as const,
    { action: "add", text: "Estimated task", effort: 3 } as const,
  ])
    assert.ok(Either.isLeft(requestTodoControl(f.pi, f.ctx, request)))

  assert.equal(calls, 0)
})

test("overlap routes every operation through the effort-aware writer without losing priority or applying twice", () => {
  const f = fixture()

  registerTodoControl(
    f.pi,
    () => assert.fail("legacy writer could erase effort"),
    { priority: true },
  )

  let calls = 0
  const capabilities = { priority: true, effort: true } as const

  const release = registerTodoControl(
    f.pi,
    (request, ctx) => {
      calls += 1
      assert.equal(ctx, f.ctx)

      return { isError: false, message: request.action }
    },
    capabilities,
  )

  const requests = [
    { action: "list" },
    { action: "status", id: 1, status: "completed" },
    { action: "priority", id: 1, priority: 2 },
    { action: "effort", id: 1, effort: 5 },
    { action: "add", text: "Optional estimate", effort: 3 },
  ] as const

  for (const request of requests)
    assert.deepEqual(
      requestTodoControl(f.pi, f.ctx, request),
      Either.right({ isError: false, message: request.action }),
    )

  assert.equal(calls, requests.length)

  release()

  assert.ok(
    Either.isLeft(
      requestTodoControl(f.pi, f.ctx, {
        action: "effort",
        id: 1,
        effort: null,
      }),
    ),
  )
})

test("todo control reports an unavailable worker handler rather than claiming a write", () => {
  const f = fixture()

  assert.ok(Either.isLeft(requestTodoControl(f.pi, f.ctx, { action: "list" })))
})

test("todo control invokes the worker's registered task handler and returns its result", () => {
  const f = fixture()
  let calls = 0

  const release = registerTodoControl(f.pi, (request, ctx) => {
    calls += 1
    assert.equal(ctx, f.ctx)
    assert.deepEqual(request, { action: "add", text: "Task" })

    return { isError: false, message: "Added worker task" }
  })

  assert.deepEqual(
    requestTodoControl(f.pi, f.ctx, { action: "add", text: "Task" }),
    Either.right({ isError: false, message: "Added worker task" }),
  )
  assert.equal(calls, 1)

  release()

  assert.ok(Either.isLeft(requestTodoControl(f.pi, f.ctx, { action: "list" })))
})

test("overlapping reload handlers cannot execute a manager mutation twice", () => {
  const f = fixture()
  let calls = 0

  const handler = () => {
    calls += 1

    return { isError: false, message: "Applied once" }
  }

  registerTodoControl(f.pi, handler)
  registerTodoControl(f.pi, handler)

  assert.ok(
    Either.isRight(requestTodoControl(f.pi, f.ctx, { action: "clear" })),
  )
  assert.equal(calls, 1)
})
