import assert from "node:assert/strict"
import test from "node:test"
import {
  inspectionResultPatch,
  mergeNestedUsage,
  runInspectionBatch,
  type InspectionRunDependencies,
} from "./inspection.ts"
import type { MutationDelta } from "./core.ts"

const delta = (toolCallId = "call-1"): MutationDelta => ({
  toolCallId,
  path: "src/value.ts",
  language: "typescript",
  exactChangedText: "const value = 1",
  resultingChangedText: "const value = 1",
  inspectors: ["idiomatic-typescript"],
})

const cleanDeterministic = {
  status: "clean" as const,
  skipped: [],
}

const dependencies = (): InspectionRunDependencies => ({
  cwd: "/repo",
  signal: undefined,
  contextFiles: [{ path: "/repo/AGENTS.md", content: "Prefer const." }],
  deterministic: async () => cleanDeterministic,
  luna: async (_prompt, files) => {
    const file = files.at(0)
    assert.ok(file)
    return {
      status: "valid" as const,
      findings: [
        {
          source: "luna" as const,
          path: file.path,
          inspector: "idiomatic-typescript" as const,
          severity: "warning" as const,
          code: "prefer-const",
          message: "Keep this binding immutable.",
        },
      ],
      contextRequests: [],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    }
  },
})

test("deterministic findings stop before any Luna launch", async () => {
  let lunaCalls = 0
  const result = await runInspectionBatch([delta()], {
    ...dependencies(),
    deterministic: async () => ({
      status: "findings",
      findings: [
        {
          source: "deterministic",
          path: "src/value.ts",
          inspector: "format-and-syntax",
          severity: "error",
          code: "deterministic-check-failed",
          message: "The configured check failed.",
        },
      ],
      skipped: [],
    }),
    luna: async (...args) => {
      lunaCalls += 1
      return dependencies().luna(...args)
    },
  })
  assert.equal(lunaCalls, 0)
  assert.equal(result.status, "findings")
  if (result.status !== "findings") return
  const finding = result.findings.at(0)
  assert.ok(finding)
  assert.equal(finding.source, "deterministic")
})

test("clean deterministic batch invokes Luna once with bounded applicable context", async () => {
  let calls = 0
  let observedPrompt = ""
  const result = await runInspectionBatch([delta("one"), delta("two")], {
    ...dependencies(),
    luna: async (prompt, files) => {
      calls += 1
      observedPrompt = prompt
      return dependencies().luna(prompt, files)
    },
  })
  assert.equal(calls, 1)
  assert.match(observedPrompt, /Prefer const/)
  assert.match(observedPrompt, /src\/value\.ts/)
  assert.equal(result.status, "findings")
  if (result.status !== "findings") return
  assert.equal(result.usage?.totalTokens, 15)
})

test("local inspectors may request but never perform contextual expansion", async () => {
  const result = await runInspectionBatch([delta()], {
    ...dependencies(),
    luna: async (_prompt, files) => {
      const file = files.at(0)
      assert.ok(file)
      return {
        status: "valid",
        findings: [],
        contextRequests: [
          {
            path: file.path,
            judgment: "invariant",
            reason: "The local delta changes a state transition.",
            symbols: ["value"],
          },
        ],
        usage: dependenciesUsage,
      }
    },
  })
  assert.equal(result.status, "findings")
  if (result.status !== "findings") return
  assert.equal(result.findings.length, 0)
  const contextRequest = result.contextRequests.at(0)
  assert.ok(contextRequest)
  assert.equal(contextRequest.judgment, "invariant")
})

const dependenciesUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
}

test("result patch is advisory, leader-local, and accounts nested usage", () => {
  const patch = inspectionResultPatch(
    {
      content: [{ type: "text", text: "Applied edit" }],
      details: { diff: "existing" },
      usage: undefined,
    },
    {
      status: "findings",
      findings: [
        {
          source: "luna",
          path: "src/value.ts",
          inspector: "idiomatic-typescript",
          severity: "warning",
          code: "prefer-const",
          message: "Keep this binding immutable.",
        },
      ],
      contextRequests: [],
      skipped: [],
      usage: dependenciesUsage,
    },
  )
  assert.equal(patch.content.length, 2)
  const advisory = patch.content.at(1)
  assert.ok(advisory)
  assert.equal(advisory.type, "text")
  if (advisory.type !== "text") return
  assert.match(advisory.text, /advisory only/i)
  assert.match(advisory.text, /grants no authority/i)
  assert.deepEqual(patch.details.diff, "existing")
  assert.equal(patch.details.writeResultInspection.status, "findings")
  assert.equal(patch.usage?.totalTokens, 15)
})

test("usage merger preserves all provider accounting fields", () => {
  assert.deepEqual(
    mergeNestedUsage(
      {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          total: 10,
        },
      },
      dependenciesUsage,
    ),
    {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 25,
      cost: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        total: 10,
      },
    },
  )
})
