import assert from "node:assert/strict"
import childProcess, { type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import test from "node:test"
import { Either } from "effect"
import {
  createOwnerAllowance,
  OWNER_ALLOWANCE_MS,
  OWNER_PARENT_DEADLINE_ENV,
} from "../classified-workflows/owner-allowance.ts"
import { makeQuestionJudge, type JudgeContext } from "./quality.ts"

const context = (execution?: JudgeContext["execution"]): JudgeContext => ({
  cwd: process.cwd(),
  ...(execution === undefined ? {} : { execution }),
  getModel: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }),
})

const clock = () => {
  let now = Date.now()
  let expire = () => {}
  const guard = createOwnerAllowance({
    now: () => now,
    schedule: callback => {
      expire = callback
      return 0
    },
    clear: () => {},
    persist: () => {},
    cancel: () => {},
  })
  return {
    guard,
    grant: () => guard.ownerInput(now),
    expire: () => {
      now += OWNER_ALLOWANCE_MS
      expire()
    },
  }
}

test("production judge must not spawn without a parent lease", async t => {
  const original = childProcess.spawn
  let spawned = false
  const mocked = t.mock.method(childProcess, "spawn", () => {
    spawned = true
    return original(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
  })
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
  await makeQuestionJudge(context())("Deadline-only regression")
  assert.equal(
    spawned,
    false,
    "an unleased native judge escapes the parent watchdog",
  )
})

test("production judge inherits the exact parent deadline", async t => {
  const { guard, grant } = clock()
  t.after(() => guard.dispose())
  const granted = grant()
  assert.ok(Either.isRight(granted))
  const original = childProcess.spawn
  let inherited: string | undefined
  const mocked = t.mock.method(
    childProcess,
    "spawn",
    (_command, _args, options) => {
      inherited = options?.env?.[OWNER_PARENT_DEADLINE_ENV]
      return original(process.execPath, ["-e", "process.exit(0)"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
    },
  )
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
  await makeQuestionJudge(context(guard))("Deadline-only regression")
  assert.equal(inherited, String(granted.right.deadlineAt))
})

test(
  "expiry stops the real in-flight judge and retains SIGKILL escalation",
  { timeout: 5_000 },
  async t => {
    const { guard, grant, expire } = clock()
    assert.ok(Either.isRight(grant()))
    const original = childProcess.spawn
    let child: ChildProcess | undefined
    let ready = () => {}
    const started = new Promise<void>(resolve => {
      ready = resolve
    })
    let unregistered = 0
    const execution: NonNullable<JudgeContext["execution"]> = {
      admit: guard.admit,
      track: terminate => {
        const unregister = guard.track(terminate)
        return () => {
          unregistered++
          unregister()
        }
      },
    }
    const mocked = t.mock.method(childProcess, "spawn", () => {
      child = original(
        process.execPath,
        [
          "-e",
          'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
      child.stdout?.once("data", ready)
      return child
    })
    syncBuiltinESMExports()
    t.after(() => {
      mocked.mock.restore()
      syncBuiltinESMExports()
      child?.kill("SIGKILL")
      guard.dispose()
    })
    const pending = makeQuestionJudge(context(execution))(
      "Deadline-only regression",
    )
    await Promise.race([
      started,
      pending.then(() =>
        assert.fail("judge settled before the subprocess became ready"),
      ),
    ])
    assert.ok(child)
    const closed = once(child, "close")
    expire()
    assert.equal(await pending, undefined)
    const [, signal] = await closed
    assert.equal(signal, "SIGKILL")
    assert.equal(unregistered, 1)
  },
)
