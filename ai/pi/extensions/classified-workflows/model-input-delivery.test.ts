import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import { createOwnerAllowance, OWNER_ALLOWANCE_MS } from "./owner-allowance.ts"
import {
  createModelInputDelivery,
  type DeliveryResult,
  type ModelInputDispatch,
} from "../../host/model-input-delivery.ts"

const value = <A>(result: DeliveryResult<A>): A => {
  if (!result.ok) assert.fail(result.error.code)
  return result.value
}
const user = (text = "same content") => ({
  role: "user",
  content: [{ type: "text", text }],
})
const fixture = (ceiling?: number) => {
  let now = 1_000
  let sequence = 0
  let saved: unknown
  const makeGuard = () =>
    createOwnerAllowance({
      inheritedDeadline: ceiling === undefined ? undefined : String(ceiling),
      now: () => now,
      schedule: () => 0,
      clear: () => {},
      persist: state => {
        saved = state
      },
      cancel: () => {},
    })
  let guard = makeGuard()
  const ledger = createModelInputDelivery({
    now: () => now,
    newId: () => `native-${++sequence}`,
  })
  const commits: ModelInputDispatch[] = []
  const register = () =>
    value(
      ledger.registerGuard("/fixture/main.ts", commit => {
        commits.push(commit)
        const admitted =
          commit.ownerInputIds.length > 0
            ? guard.ownerInput(commit.dispatchedAt)
            : guard.admit()
        return Either.isRight(admitted)
          ? { action: "allow" }
          : { action: "block", reason: admitted.left.message }
      }),
    )
  const binding = register()
  return {
    ledger,
    binding,
    commits,
    guard: () => guard,
    at: (time: number) => {
      now = time
    },
    reload: () => {
      guard.dispose()
      guard = makeGuard()
      guard.restore(saved)
      return register()
    },
  }
}

test("owner arrival and queueing grant nothing; actual dispatch grants a full window exactly once", () => {
  const f = fixture()
  const receipt = value(f.ledger.acceptInput("interactive"))
  value(f.binding.authorizeInput(receipt.id))
  const message = user()
  value(f.ledger.associate(receipt, message, true))
  f.at(500_000)
  assert.ok(Either.isLeft(f.guard().admit()))
  assert.equal(f.commits.length, 0)
  let requests = 0
  value(f.ledger.dispatch([message], () => requests++))
  const window = f.guard().admit()
  assert.ok(Either.isRight(window))
  assert.equal(window.right.lastOwnerAt, 500_000)
  assert.equal(window.right.deadlineAt, 500_000 + OWNER_ALLOWANCE_MS)
  f.at(600_000)
  value(f.ledger.dispatch([message], () => requests++))
  const unchanged = f.guard().admit()
  assert.ok(Either.isRight(unchanged))
  assert.equal(unchanged.right.deadlineAt, window.right.deadlineAt)
  assert.equal(f.commits[1]?.ownerInputIds.length, 0)
  assert.equal(requests, 2)
})

test("identical automated text, forged fields and forged receipt objects cannot renew", () => {
  const f = fixture()
  const owner = value(f.ledger.acceptInput("interactive"))
  value(f.binding.authorizeInput(owner.id))
  const ownerMessage = user()
  value(f.ledger.associate(owner, ownerMessage, true))
  const automation = value(f.ledger.acceptInput("extension"))
  const automatedMessage = {
    ...user(),
    inputId: owner.id,
    source: "interactive",
  }
  value(f.ledger.associate(automation, automatedMessage, false))
  assert.equal(f.ledger.associate({ id: owner.id }, user(), false).ok, false)
  let sent = false
  const denied = f.ledger.dispatch(
    [automatedMessage, { ...ownerMessage }],
    () => {
      sent = true
    },
  )
  assert.equal(denied.ok, false)
  assert.equal(sent, false)
  assert.equal(f.commits[0]?.ownerInputIds.length, 0)
  value(f.ledger.dispatch([ownerMessage], () => {}))
  assert.equal(f.commits[1]?.ownerInputIds[0], owner.id)
})

test("host-owned clones preserve image-only lineage; mutation invalidates it", () => {
  const f = fixture()
  const receipt = value(f.ledger.acceptInput("interactive"))
  const message = {
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "fixture-bytes" }],
  }
  value(f.binding.authorizeInput(receipt.id))
  value(f.ledger.associate(receipt, message, false))
  const clone = structuredClone(message)
  value(f.ledger.preserveClone(message, clone))
  clone.content[0].data = "replaced"
  const denied = f.ledger.dispatch([clone], () =>
    assert.fail("must not dispatch mutated owner content"),
  )
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, "mutated-input")
  value(f.ledger.dispatch([message], () => {}))
  assert.equal(f.commits[0]?.ownerInputIds[0], receipt.id)
})

test("pending authority survives extension reload, but consumed input never grants again", () => {
  const f = fixture()
  const receipt = value(f.ledger.acceptInput("interactive"))
  const message = user()
  value(f.binding.authorizeInput(receipt.id))
  value(f.ledger.associate(receipt, message, true))
  f.ledger.beginGuardReload()
  assert.equal(
    f.ledger.dispatch([message], () =>
      assert.fail("guard absent during reload"),
    ).ok,
    false,
  )
  const binding = f.reload()
  assert.equal(binding.isInputAuthorized(receipt.id), true)
  f.at(300_000)
  value(f.ledger.dispatch([message], () => {}))
  f.reload()
  f.at(400_000)
  value(f.ledger.dispatch([message], () => {}))
  assert.deepEqual(
    f.commits.map(commit => commit.ownerInputIds.length),
    [1, 0],
  )
})

test("cleared, handled and cancelled inputs cannot grant; preparing is not delivery", () => {
  for (const clear of [true, false]) {
    const f = fixture()
    const receipt = value(f.ledger.acceptInput("interactive"))
    const message = user()
    value(f.binding.authorizeInput(receipt.id))
    value(f.ledger.associate(receipt, message, true))
    if (clear) f.ledger.clearQueued()
    else {
      f.ledger.prepareMessage(message)
      value(f.ledger.cancelInput(receipt))
    }
    assert.equal(
      f.ledger.dispatch([message], () => assert.fail("cancelled input sent"))
        .ok,
      false,
    )
    assert.ok(Either.isLeft(f.guard().admit()))
  }
})

test("original inherited ceiling still wins even for newly delivered owner input", () => {
  const f = fixture(OWNER_ALLOWANCE_MS + 1_000)
  const receipt = value(f.ledger.acceptInput("interactive"))
  const message = user()
  value(f.binding.authorizeInput(receipt.id))
  value(f.ledger.associate(receipt, message, true))
  f.at(OWNER_ALLOWANCE_MS + 1_001)
  assert.equal(
    f.ledger.dispatch([message], () =>
      assert.fail("inherited ceiling bypassed"),
    ).ok,
    false,
  )
})

test("pre-dispatch abort sends nothing; local handoff failure consumes exactly once", () => {
  const f = fixture()
  const receipt = value(f.ledger.acceptInput("interactive"))
  const message = user()
  value(f.binding.authorizeInput(receipt.id))
  value(f.ledger.associate(receipt, message, false))
  const controller = new AbortController()
  controller.abort()
  assert.equal(
    f.ledger.dispatch(
      [message],
      () => assert.fail("aborted request sent"),
      controller.signal,
    ).ok,
    false,
  )
  assert.equal(f.commits.length, 0)
  const failed = f.ledger.dispatch([message], () => {
    throw new Error("simulated transport boundary")
  })
  assert.equal(failed.ok, false)
  f.at(2_000)
  value(f.ledger.dispatch([message], () => {}))
  assert.deepEqual(
    f.commits.map(commit => commit.ownerInputIds.length),
    [1, 0],
  )
})

test("malformed clocks and duplicate native IDs fail specifically without dispatch", () => {
  const ledger = createModelInputDelivery({
    now: () => Number.NaN,
    newId: () => "duplicate",
  })
  value(ledger.acceptInput("interactive"))
  const duplicate = ledger.acceptInput("extension")
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, "duplicate-id")
  const badClock = ledger.dispatch([], () =>
    assert.fail("invalid clock admitted"),
  )
  assert.equal(badClock.ok, false)
  if (!badClock.ok) assert.equal(badClock.error.code, "invalid-clock")
})
