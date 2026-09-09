import assert from "node:assert/strict"
import test from "node:test"
import {
  buildInspectorArguments,
  decodeInspectorProcessOutput,
  runLunaInspector,
  type InspectorProcessDependencies,
} from "./inspector-process.ts"
import type { InspectionBatchFile } from "./core.ts"

const files: readonly InspectionBatchFile[] = [
  {
    path: "src/value.ts",
    language: "typescript",
    exactChangedText: "const value = 1",
    resultingChangedText: "const value = 1",
    inspectors: ["idiomatic-typescript"],
  },
]

const assistantLine = (text: string) =>
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: {
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    },
  })

test("Luna subprocess is tool-less, context-free, single-attempt, and low-thinking", () => {
  const args = buildInspectorArguments("inspect this")
  assert.deepEqual(args.slice(0, 2), ["--mode", "json"])
  for (const flag of [
    "--print",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ])
    assert.ok(args.includes(flag), flag)
  assert.deepEqual(
    args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
    ["--model", "openai-codex/gpt-5.6-luna"],
  )
  assert.deepEqual(
    args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2),
    ["--thinking", "low"],
  )
  assert.equal(args.at(-1), "inspect this")
})

test("process output decodes closed findings and validated nested usage", () => {
  const output = decodeInspectorProcessOutput(
    `${assistantLine(
      JSON.stringify({
        findings: [
          {
            fileIndex: 0,
            inspector: "idiomatic-typescript",
            severity: "warning",
            code: "prefer-const",
            message: "Keep the value immutable.",
          },
        ],
        contextRequests: [],
      }),
    )}\n`,
    files,
  )
  assert.equal(output.status, "valid")
  if (output.status !== "valid") return
  const finding = output.findings.at(0)
  assert.ok(finding)
  assert.equal(finding.path, "src/value.ts")
  assert.equal(output.usage.totalTokens, 165)
})

test("missing usage, malformed completion, and policy text fail closed", () => {
  const missingUsage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: JSON.stringify({ findings: [], contextRequests: [] }),
        },
      ],
      stopReason: "stop",
    },
  })
  assert.deepEqual(decodeInspectorProcessOutput(missingUsage, files), {
    status: "invalid",
    reason: "malformed-process-output",
  })
  for (const output of [
    assistantLine("```json\n{}\n```"),
    assistantLine('{"findings":[],"contextRequests":[],"action":"push"}'),
  ]) {
    const decoded = decodeInspectorProcessOutput(output, files)
    assert.equal(decoded.status, "invalid")
    if (decoded.status !== "invalid") continue
    assert.equal(decoded.reason, "malformed-process-output")
    assert.equal(decoded.usage?.totalTokens, 165)
  }
})

test("one bounded process attempt returns valid result without exposing stderr", async () => {
  const dependencies: InspectorProcessDependencies = {
    cwd: "/repo",
    signal: undefined,
    exec: async () => ({
      code: 0,
      stdout: assistantLine(
        JSON.stringify({ findings: [], contextRequests: [] }),
      ),
      stderr: "sensitive-looking provider diagnostic",
      killed: false,
    }),
  }
  const result = await runLunaInspector("inspect", files, dependencies)
  assert.equal(result.status, "valid")
  assert.doesNotMatch(JSON.stringify(result), /provider diagnostic/)
})

test("failed process still returns observed usage for accounting", async () => {
  const result = await runLunaInspector("inspect", files, {
    cwd: "/repo",
    signal: undefined,
    exec: async () => ({
      code: 1,
      stdout: assistantLine('{"findings":[],"contextRequests":[]}'),
      stderr: "provider failure",
      killed: false,
    }),
  })
  assert.equal(result.status, "skipped")
  if (result.status !== "skipped") return
  assert.equal(result.reason, "unavailable")
  assert.equal(result.usage?.totalTokens, 165)
})

test("abort or deadline never retries and returns a typed skip", async () => {
  for (const mode of ["abort", "timeout"] as const) {
    let attempts = 0
    const controller = new AbortController()
    if (mode === "abort") controller.abort()
    const result = await runLunaInspector("inspect", files, {
      cwd: "/repo",
      signal: controller.signal,
      exec: async () => {
        attempts += 1
        return { code: null, stdout: "", stderr: "", killed: true }
      },
    })
    assert.deepEqual(result, {
      status: "skipped",
      reason: mode === "abort" ? "cancelled" : "timeout",
    })
    assert.equal(attempts, mode === "abort" ? 0 : 1)
  }
})
