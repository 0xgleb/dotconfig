import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test, { type TestContext } from "node:test"
import { parseClassifierDecision, type Decision } from "./core.ts"
import {
  buildClassifierPrompt,
  type ClassificationRequest,
} from "./lifecycle.ts"
import { sanitizeProcessDiagnostic, unknownErrorMessage } from "./protocol.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const start = source.indexOf("const classifierBackoff:")
const end = source.indexOf("async function evaluateGoal(", start)
assert.ok(start >= 0 && end > start)
const constants = [
  "CLASSIFIER_MODEL",
  "CLASSIFIER_TIMEOUT_MS",
  "CLASSIFIER_MAX_ATTEMPTS",
  "CLASSIFIER_RETRY_BASE_MS",
]
  .map(name => {
    const match = source.match(new RegExp(`^const ${name} = .+$`, "m"))
    assert.ok(match, name)
    return match[0]
  })
  .join("\n")

type ProcessResult = {
  exitCode: number
  output: string
  stopReason?: string
  errorMessage?: string
}
type Provider = (signal: AbortSignal) => Promise<ProcessResult>
type Classify = (
  request: ClassificationRequest,
  context: { cwd: string },
  signal: AbortSignal,
  activity: (active: boolean) => void,
) => Promise<Decision>

const allow: Decision = {
  verdict: "allow",
  reason: "authorized",
  source: "classifier",
}
const success = (decision: Decision): ProcessResult => ({
  exitCode: 0,
  output: JSON.stringify(decision),
})
const unavailable: ProcessResult = {
  exitCode: 1,
  output: "",
  errorMessage: "transient unavailable",
}
const cancelled: ProcessResult = {
  exitCode: 143,
  output: "",
  stopReason: "aborted",
}

// Exercise the actual retry/deadline implementation without starting a model process.
const harness = (t: TestContext, provider: Provider) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const attempts: AbortSignal[] = []
  const activities: boolean[] = []
  const classify: Classify = new Function(
    "dependencies",
    `
    const { runPi, buildClassifierPrompt, parseClassifierDecision,
      sanitizeProcessDiagnostic, unknownErrorMessage } = dependencies;
    ${constants}
    const CLASSIFIER_SYSTEM_PROMPT = "classifier protocol test";
    ${stripTypeScriptTypes(source.slice(start, end))}
    return classify;
  `,
  )({
    runPi: (_args: string[], _cwd: string, signal: AbortSignal) => {
      attempts.push(signal)
      return provider(signal)
    },
    buildClassifierPrompt,
    parseClassifierDecision,
    sanitizeProcessDiagnostic,
    unknownErrorMessage,
  })
  const controller = new AbortController()
  let decision: Decision | undefined
  const pending = classify(
    {
      boundary: "action",
      intent: ["Inspect authorized source"],
      projectInstructions: "Only inspect source in the authorized project.",
      subject: { toolName: "read", input: { path: "src/main.ts" } },
    },
    { cwd: "/project" },
    controller.signal,
    active => activities.push(active),
  ).then(value => {
    decision = value
  })
  t.after(async () => {
    controller.abort()
    await pending
  })
  return { attempts, activities, controller, decision: () => decision }
}

const tick = async (t: TestContext, milliseconds: number) => {
  t.mock.timers.tick(milliseconds)
  await new Promise<void>(resolve => setImmediate(resolve))
}

test("a valid classifier response after the old 20-second deadline survives", async t => {
  const run = harness(
    t,
    signal =>
      new Promise(resolve => {
        const abort = () => {
          clearTimeout(timer)
          resolve(cancelled)
        }
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort)
          resolve(success(allow))
        }, 25_000)
        signal.addEventListener("abort", abort, { once: true })
      }),
  )
  await tick(t, 25_000)
  assert.deepEqual(run.decision(), allow)
  assert.equal(run.attempts.length, 1)
  assert.equal(run.attempts[0]?.aborted, false)
  assert.deepEqual(run.activities, [true, false])
})

test("a third bounded attempt recovers two transient availability failures", async t => {
  let calls = 0
  const run = harness(t, async () =>
    ++calls < 3 ? unavailable : success(allow),
  )
  await tick(t, 0)
  await tick(t, 1_000)
  await tick(t, 2_000)
  assert.equal(run.attempts.length, 3)
  assert.deepEqual(run.decision(), allow)
})

test("classifier deadlines still abort at 60 seconds and exhaust fail-closed", async t => {
  const run = harness(
    t,
    signal =>
      new Promise(resolve => {
        signal.addEventListener("abort", () => resolve(cancelled), {
          once: true,
        })
      }),
  )
  await tick(t, 59_999)
  assert.equal(run.attempts[0]?.aborted, false)
  await tick(t, 1)
  assert.equal(run.attempts[0]?.aborted, true)
  await tick(t, 1_000)
  await tick(t, 60_000)
  await tick(t, 2_000)
  await tick(t, 60_000)
  assert.equal(run.attempts.length, 3)
  assert.equal(run.decision()?.verdict, "block")
  assert.match(
    run.decision()?.reason ?? "",
    /unavailable after 3 attempts.*timed out after 60 seconds/,
  )
  await tick(t, 120_000)
  assert.equal(run.attempts.length, 3)
  assert.deepEqual(run.activities, [true, false])
})

test("a genuine policy block is returned without retries", async t => {
  const block: Decision = {
    verdict: "block",
    reason: "outside scope",
    source: "classifier",
  }
  const run = harness(t, async () => success(block))
  await tick(t, 0)
  assert.deepEqual(run.decision(), block)
  assert.equal(run.attempts.length, 1)
})

test("owner cancellation during retry backoff starts no further attempt", async t => {
  const run = harness(t, async () => unavailable)
  await tick(t, 0)
  run.controller.abort()
  await tick(t, 0)
  await tick(t, 120_000)
  assert.equal(run.attempts.length, 1)
  assert.equal(run.decision()?.verdict, "block")
  assert.deepEqual(run.activities, [true, false])
})
