import assert from "node:assert/strict"
import test from "node:test"
import compactRead from "../pi/extensions/compact-read/index.ts"

test("compact read expands at initial startup but preserves disclosure on reload", () => {
  const handlers = new Map<string, unknown>()
  Reflect.apply(compactRead, undefined, [
    {
      on: (name: string, handler: unknown) => {
        handlers.set(name, handler)
      },
      registerTool: () => {},
      events: { on: () => () => {} },
    },
  ])
  const start = handlers.get("session_start")
  assert.ok(typeof start === "function")
  let expanded = false
  const ctx = {
    mode: "tui",
    ui: {
      setToolsExpanded: (value: boolean) => {
        expanded = value
      },
    },
  }
  start({ reason: "startup" }, ctx)
  assert.equal(expanded, true)
  for (const reason of ["reload", "new", "resume", "fork"]) {
    for (const choice of [false, true]) {
      expanded = choice
      start({ reason }, ctx)
      assert.equal(expanded, choice, reason)
    }
  }
})
