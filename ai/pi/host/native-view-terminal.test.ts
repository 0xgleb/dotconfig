import assert from "node:assert/strict"
import test from "node:test"
import type { Terminal } from "@earendil-works/pi-tui"
import { createNativeViewTerminals } from "./native-view-terminal.ts"

const fixture = (stopMode: "normal" | "fail" = "normal") => {
  const writes: string[] = []
  const inputs: ((value: string) => void)[] = []
  let stops = 0
  const physical: Terminal = {
    start: input => {
      inputs.push(input)
    },
    stop: () => {
      stops += 1
      if (stopMode === "fail") assert.fail("Injected terminal stop failure")
    },
    drainInput: async () => {
      writes.push("drain")
    },
    write: value => {
      writes.push(value)
    },
    columns: 100,
    rows: 40,
    kittyProtocolActive: true,
    moveBy: value => {
      writes.push(`move:${value}`)
    },
    hideCursor: () => {
      writes.push("hide")
    },
    showCursor: () => {
      writes.push("show")
    },
    clearLine: () => {
      writes.push("line")
    },
    clearFromCursor: () => {
      writes.push("from-cursor")
    },
    clearScreen: () => {
      writes.push("screen")
    },
    setTitle: value => {
      writes.push(`title:${value}`)
    },
    setProgress: value => {
      writes.push(`progress:${value}`)
    },
    setProgramStatus: () => {
      writes.push("status")
    },
  }
  return {
    writes,
    inputs,
    stops: () => stops,
    views: createNativeViewTerminals(physical),
  }
}

test("inactive native view cannot write terminal effects or consume active input", async () => {
  const f = fixture()
  const manager = f.views.manager
  manager.start(
    () => assert.fail("Inactive input"),
    () => assert.fail("Inactive resize"),
  )
  manager.write("not visible")
  manager.moveBy(1)
  manager.hideCursor()
  manager.showCursor()
  manager.clearLine()
  manager.clearFromCursor()
  manager.clearScreen()
  manager.setTitle("not active")
  manager.setProgress(true)
  manager.setProgramStatus({ state: "working" })
  await manager.drainInput()
  manager.stop()
  assert.deepEqual(f.writes, [])
  assert.equal(f.inputs.length, 0)
  assert.equal(f.stops(), 0)
})

test("switching retains independent editor input handlers and fences stale delivery", () => {
  const f = fixture()
  const workerDraft: string[] = []
  const managerDraft: string[] = []
  f.views.worker.start(
    value => workerDraft.push(value),
    () => {},
  )
  f.inputs[0]("worker draft")
  assert.deepEqual(f.views.activate("manager"), { ok: true })
  f.views.manager.start(
    value => managerDraft.push(value),
    () => {},
  )
  f.inputs[0]("stale worker input")
  f.inputs[1]("manager draft")
  f.views.worker.write("background stream")
  f.views.manager.write("visible manager")
  assert.deepEqual(workerDraft, ["worker draft"])
  assert.deepEqual(managerDraft, ["manager draft"])
  assert.deepEqual(f.writes, ["visible manager"])
  assert.equal(f.stops(), 1)
  assert.equal(f.views.active(), "manager")
  assert.deepEqual(f.views.activate("worker"), { ok: true })
  f.inputs[0]("stale first activation")
  f.inputs[1]("stale manager activation")
  f.inputs[2]("returned worker")
  assert.deepEqual(workerDraft, ["worker draft", "returned worker"])
  assert.deepEqual(managerDraft, ["manager draft"])
})

test("terminal handoff failure leaves ownership unchanged and reports a typed failure", () => {
  const f = fixture("fail")
  assert.deepEqual(f.views.activate("manager"), {
    ok: false,
    code: "terminal_failure",
  })
  assert.equal(f.views.active(), "worker")
  f.views.manager.write("must remain hidden")
  f.views.worker.write("still worker")
  assert.deepEqual(f.writes, ["still worker"])
})

test("unknown view cannot stop or retarget the native terminal", () => {
  const f = fixture()
  assert.deepEqual(f.views.activate("foreign"), {
    ok: false,
    code: "invalid_view",
  })
  assert.equal(f.stops(), 0)
  assert.equal(f.views.active(), "worker")
  assert.equal(f.views.manager.columns, 100)
  assert.equal(f.views.manager.rows, 40)
  assert.equal(f.views.manager.kittyProtocolActive, true)
})
