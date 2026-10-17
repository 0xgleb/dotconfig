import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { Effect, Either } from "effect"
import {
  runWorkflowScript,
  type AgentResult,
  type AgentUsageObserver,
  type WorkflowDependencies,
  type WorkflowLimits,
} from "./core.ts"
import { createClassifiedAgentRunner } from "./lifecycle.ts"
import { auditedAgentRunner, type ChildAudit } from "./workflow-audit.ts"
import {
  boundedDiagnosticTail,
  piProcessProgressFromJsonLine,
  sanitizeProcessDiagnostic,
  summarizePiJsonLines,
  usageTokensFromPiJsonLine,
} from "./protocol.ts"

const limits: WorkflowLimits = {
  maxAgents: 1,
  concurrency: 1,
  agentTimeoutMs: 20,
  workflowTimeoutMs: 1_500,
  retries: 0,
  tokenBudget: 8_000,
}

const run = (
  runAgent: WorkflowDependencies["runAgent"],
  code = "return await agent('bounded child');",
  overrides: Partial<WorkflowLimits> = {},
  signal?: AbortSignal,
) =>
  runWorkflowScript(
    code,
    { ...limits, ...overrides },
    {
      runAgent,
      availableMemoryBytes: () => Number.MAX_SAFE_INTEGER,
      checkpoint: async () => "approved",
    },
    signal,
  )

const assertTimeoutUsage = (result: unknown, expected: number) => {
  assert.deepEqual(result, {
    status: "timed-out",
    output: "",
    reason: "Agent timed out",
    usageTokens: expected,
  })
}

test("the real process adapter reports parsed streaming usage before process close", async t => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = source.indexOf("async function runPi(")
  const end = source.indexOf("function messageText(", start)
  assert.ok(start >= 0 && end > start)
  const signals: string[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: (signal: string) => {
      signals.push(signal)
      return true
    },
  })
  type RunPi = (
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    tokenLimit?: number,
    onProgress?: (progress: string) => void,
    onUsage?: AgentUsageObserver,
  ) => Promise<{ usageTokens: number; exitCode: number }>
  const runPi: RunPi = new Function(
    "dependencies",
    `
    const { spawn, process, piInvocation, Effect, Either,
      boundedDiagnosticTail, piProcessProgressFromJsonLine,
      sanitizeProcessDiagnostic, summarizePiJsonLines,
      usageTokensFromPiJsonLine } = dependencies;
    const AGENT_PROCESS_STDIO = ['ignore', 'pipe', 'pipe'];
    const WORKFLOW_CHILD_TOKEN_LIMIT_ENV = 'synthetic-token-limit';
    const MAX_CHILD_STDERR_CHARACTERS = 1000;
    ${stripTypeScriptTypes(source.slice(start, end))}
    return runPi;
  `,
  )({
    spawn: () => child,
    process: { env: {} },
    piInvocation: (args: string[]) => ({ command: "synthetic", args }),
    Effect,
    Either,
    boundedDiagnosticTail,
    piProcessProgressFromJsonLine,
    sanitizeProcessDiagnostic,
    summarizePiJsonLines,
    usageTokensFromPiJsonLine,
  })
  const observations: number[] = []
  const pending = runPi([], "/synthetic", undefined, 7, undefined, value =>
    observations.push(value),
  )
  t.after(async () => {
    child.emit("close", 0)
    await pending
  })
  const usageLine = (role: string, totalTokens: number) =>
    JSON.stringify({
      type: "message_end",
      message: { role, content: [], usage: { totalTokens } },
    })
  const first = usageLine("assistant", 3)
  child.stdout.emit("data", Buffer.from(first.slice(0, 10)))
  assert.deepEqual(observations, [])
  child.stdout.emit(
    "data",
    Buffer.from(first.slice(10) + "\n" + usageLine("toolResult", 999) + "\n"),
  )
  assert.equal(observations.at(-1), 3)
  child.stdout.emit("data", Buffer.from(usageLine("assistant", 5) + "\n"))
  assert.equal(observations.at(-1), 8)
  assert.deepEqual(signals, ["SIGTERM"])
  child.emit("close", 0)
  assert.equal((await pending).usageTokens, 8)
})

test("deadline usage crosses the classified and audited runner before the child settles", async () => {
  const audits: ChildAudit[] = []
  const classified = createClassifiedAgentRunner([], "", {
    classify: async request =>
      request.boundary === "spawn"
        ? { verdict: "allow", reason: "synthetic spawn", source: "classifier" }
        : {
            verdict: "block",
            reason: "Classifier unavailable",
            source: "classifier",
          },
    execute: async (_request, signal, _limit, _progress, onUsage) => {
      assert.ok(signal)
      onUsage?.(321)
      return new Promise<AgentResult>(resolve => {
        signal.addEventListener(
          "abort",
          () =>
            resolve({
              status: "timed-out",
              output: "",
              reason: "Agent timed out",
              usageTokens: 321,
            }),
          { once: true },
        )
      })
    },
  })
  const result = await run(auditedAgentRunner(classified, audits, text => text))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.status, "blocked")
  assert.equal(audits[0]?.usageTokens, 321)
  assert.equal(audits[0]?.outputCharacters, 0)
  assertTimeoutUsage(result, 321)
})

test("an unresponsive child cannot erase observed usage or delay the deadline", async () => {
  const result = await run(async (_request, _signal, _limit, onUsage) => {
    onUsage?.(45)
    return new Promise<AgentResult>(() => undefined)
  })
  assertTimeoutUsage(result, 45)
})

test("a settled observer cannot retroactively abort its completed attempt", async () => {
  const attempts: Array<{ signal: AbortSignal; onUsage: AgentUsageObserver }> =
    []
  const result = await run(async (_request, signal, _limit, onUsage) => {
    assert.ok(onUsage)
    attempts.push({ signal, onUsage })
    onUsage(3)
    return { status: "completed", output: "done", usageTokens: 3 }
  })
  const attempt = attempts[0]
  assert.ok(attempt)
  attempt.onUsage(99)
  attempt.onUsage(-1)
  assert.equal(attempt.signal.aborted, false)
  assert.deepEqual(result, {
    status: "completed",
    output: "done",
    usageTokens: 3,
  })
})

test("cumulative usage observations and final results are counted once", async () => {
  const result = await run(async (_request, _signal, _limit, onUsage) => {
    onUsage?.(3)
    onUsage?.(3)
    onUsage?.(9)
    return { status: "completed", output: "done", usageTokens: 9 }
  })
  assert.deepEqual(result, {
    status: "completed",
    output: "done",
    usageTokens: 9,
  })
})

test("retries retain observed usage from a thrown attempt without double counting", async () => {
  let attempts = 0
  const result = await run(
    async (_request, _signal, _limit, onUsage) => {
      attempts += 1
      if (attempts === 1) {
        onUsage?.(121)
        throw new Error("Agent timed out")
      }
      onUsage?.(10)
      return { status: "completed", output: "recovered", usageTokens: 10 }
    },
    undefined,
    { retries: 1 },
  )
  assert.equal(attempts, 2)
  assert.deepEqual(result, {
    status: "completed",
    output: "recovered",
    usageTokens: 131,
  })
})

test("invalid or regressing observations fail closed even when a child returns immediately", async () => {
  for (const value of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    4,
  ]) {
    const result = await run(async (_request, _signal, _limit, onUsage) => {
      onUsage?.(5)
      onUsage?.(value)
      return { status: "completed", output: "must not escape", usageTokens: 5 }
    })
    assert.ok(result !== null && typeof result === "object")
    assert.ok(
      "status" in result && "reason" in result && "usageTokens" in result,
    )
    assert.equal(result.status, "failed")
    assert.match(String(result.reason), /invalid agent usage observation/i)
    assert.equal(result.usageTokens, 5)
  }
})

test("a final result cannot understate cumulative observed usage", async () => {
  const result = await run(async (_request, _signal, _limit, onUsage) => {
    onUsage?.(10)
    return { status: "completed", output: "must not escape", usageTokens: 9 }
  })
  assert.ok(result !== null && typeof result === "object")
  assert.ok("status" in result && "reason" in result && "usageTokens" in result)
  assert.equal(result.status, "failed")
  assert.match(String(result.reason), /invalid agent usage result/i)
  assert.equal(result.usageTokens, 10)
})

test("observed timeout usage remains charged across workflow phases", async () => {
  let attempts = 0
  await assert.rejects(
    run(async (_request, _signal, _limit, onUsage) => {
      attempts += 1
      onUsage?.(6_000)
      return new Promise<AgentResult>(() => undefined)
    }, "await agent('first'); phase('next'); return await agent('second');"),
    /token budget/i,
  )
  assert.equal(attempts, 1)
})

test("workflow cancellation remains cancellation despite observed usage", async () => {
  const controller = new AbortController()
  await assert.rejects(
    run(
      async (_request, _signal, _limit, onUsage) => {
        onUsage?.(17)
        controller.abort(new Error("Workflow cancelled for test"))
        return new Promise<AgentResult>(() => undefined)
      },
      undefined,
      {},
      controller.signal,
    ),
    /Workflow cancelled for test/,
  )
})
