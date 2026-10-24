import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { parseClassifierDecision, type Decision } from "./core.ts"
import {
  classifierAttemptBudget,
  type ClassificationRequest,
} from "./lifecycle.ts"

type ProcessResult = {
  readonly exitCode: number
  readonly stopReason: "stop" | "error" | "aborted"
  readonly output: string
  readonly errorMessage?: string
}
type RunPi = (
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<ProcessResult>
type Classify = (
  request: ClassificationRequest,
  ctx: { cwd: string },
  signal?: AbortSignal,
  activity?: (active: boolean) => void,
) => Promise<Decision>

// Use the production loop, substituting only the child process and retry delay.
const extension = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const start = extension.indexOf("async function classify(")
const end = extension.indexOf("\nasync function evaluateGoal(", start)
assert.ok(start >= 0 && end > start)
const source = stripTypeScriptTypes(extension.slice(start, end))
const harness = (run: RunPi) => {
  const backoffs: number[] = []
  const preferred: string[] = []
  const classify = new Function(
    "classifierCandidates",
    "classifierAttemptBudget",
    "runPi",
    "parseClassifierDecision",
    "markPreferredProvider",
    "sanitizeProcessDiagnostic",
    "unknownErrorMessage",
    "classifierBackoff",
    "buildClassifierPrompt",
    `const CLASSIFIER_TIMEOUT_MS = 60000;
     const CLASSIFIER_SYSTEM_PROMPT = "classify the bounded operation";
     ${source}
     return classify;`,
  )(
    () => ["zai/glm-5.3"],
    classifierAttemptBudget,
    run,
    parseClassifierDecision,
    (model: string) => preferred.push(model),
    (diagnostic: string) => diagnostic,
    (error: unknown, fallback: string) =>
      error instanceof Error ? error.message : fallback,
    async (attempt: number) => {
      backoffs.push(attempt)
    },
    () => "bounded test operation",
  ) as Classify
  return { classify, backoffs, preferred }
}
const request: ClassificationRequest = {
  boundary: "action",
  intent: ["Inspect the requested source."],
  projectInstructions: "Read-only inspection.",
  subject: { toolName: "read", path: "src/example.ts" },
}
const ctx = { cwd: "/projects/example" }
const aborted: ProcessResult = {
  exitCode: 1,
  stopReason: "aborted",
  output: "",
  errorMessage: "This operation was aborted",
}
const decision = (verdict: "allow" | "block"): ProcessResult => ({
  exitCode: 0,
  stopReason: "stop",
  output: JSON.stringify({ verdict, reason: "classified operation" }),
})

for (const failure of ["aborted result", "AbortError rejection"] as const) {
  test(`one candidate retries a transient ${failure} and returns the later decision`, async () => {
    let calls = 0
    const f = harness(async (args, cwd, signal) => {
      assert.equal(cwd, ctx.cwd)
      assert.equal(signal.aborted, false)
      assert.equal(args[args.indexOf("--model") + 1], "zai/glm-5.3")
      calls += 1
      if (calls === 1) {
        if (failure === "AbortError rejection")
          throw new DOMException("This operation was aborted", "AbortError")
        return aborted
      }
      return decision("allow")
    })
    assert.equal((await f.classify(request, ctx)).verdict, "allow")
    assert.equal(calls, 2)
    assert.deepEqual(f.backoffs, [0])
    assert.deepEqual(f.preferred, ["zai/glm-5.3"])
  })
}

test("one exhausted candidate uses all three attempts and reports the actual count", async () => {
  let calls = 0
  const activity: boolean[] = []
  const f = harness(async () => {
    calls += 1
    return aborted
  })
  const result = await f.classify(request, ctx, undefined, active =>
    activity.push(active),
  )
  assert.equal(calls, 3)
  assert.equal(result.verdict, "block")
  assert.match(
    result.reason,
    /unavailable after 3 attempts; last failure: This operation was aborted/,
  )
  assert.deepEqual(f.backoffs, [0, 1])
  assert.deepEqual(f.preferred, [])
  assert.deepEqual(activity, [true, false])
})

test("parent cancellation stops retries even when the configured budget is three", async () => {
  let calls = 0
  const parent = new AbortController()
  const f = harness(async (_args, _cwd, signal) => {
    calls += 1
    parent.abort(new Error("Cancelled by user"))
    assert.equal(signal.aborted, true)
    return aborted
  })
  const result = await f.classify(request, ctx, parent.signal)
  assert.equal(calls, 1)
  assert.equal(result.verdict, "block")
  assert.match(
    result.reason,
    /after 1 attempts; last failure: Cancelled by user/,
  )
  assert.deepEqual(f.backoffs, [])
  assert.deepEqual(f.preferred, [])
})

test("a valid policy block is returned without retries", async () => {
  let calls = 0
  const f = harness(async () => {
    calls += 1
    return decision("block")
  })
  assert.equal((await f.classify(request, ctx)).verdict, "block")
  assert.equal(calls, 1)
  assert.deepEqual(f.backoffs, [])
})
