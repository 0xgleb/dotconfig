import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { Decision } from "./core.ts"
import {
  createClassifiedAgentRunner,
  type ClassificationRequest,
} from "./lifecycle.ts"
import {
  auditedAgentRunner,
  emptyWorkflowAuditState,
  workflowAuditEvidence,
  type ChildAudit,
} from "./workflow-audit.ts"

const allow: Decision = {
  verdict: "allow",
  reason: "test classifier permits scoped execution",
  source: "classifier",
}

test("live evidence refreshes between spawn and return without mutating parent facts", async () => {
  const classifications: ClassificationRequest[] = []
  const parentEvidence = ["existing parent fact"]
  let settled: readonly string[] = []
  const run = createClassifiedAgentRunner(
    [],
    "Read-only test",
    {
      workflowEvidence: () => settled,
      classify: async request => {
        classifications.push(request)
        return allow
      },
      execute: async () => {
        settled = ["settled sibling status=failed"]
        return { status: "completed", output: "result", usageTokens: 1 }
      },
    },
    [],
    parentEvidence,
  )

  await run({ task: "observe" }, undefined)
  assert.deepEqual(classifications[0]?.evidence, ["existing parent fact"])
  assert.deepEqual(classifications[1]?.evidence, [
    "existing parent fact",
    "settled sibling status=failed",
  ])
  assert.deepEqual(parentEvidence, ["existing parent fact"])
})

test("a later child receives the actual normalized failure of a settled reviewer", async () => {
  const classifications: ClassificationRequest[] = []
  const children: ChildAudit[] = []
  const classified = createClassifiedAgentRunner([], "Read-only test", {
    workflowEvidence: () =>
      workflowAuditEvidence(emptyWorkflowAuditState, {
        id: "wf-9",
        children,
      }),
    classify: async request => {
      classifications.push(request)
      return allow
    },
    execute: async request => ({
      status: "completed",
      output:
        request.task === "reviewer"
          ? JSON.stringify({
              findings: [],
              reviewer_error: "source unavailable",
            })
          : "writer observed runtime evidence",
      usageTokens: 1,
    }),
  })
  const run = auditedAgentRunner(classified, children, String)
  const signal = new AbortController().signal
  const failed = await run({ task: "reviewer", tools: ["read"] }, signal, 1_000)
  assert.equal(failed.status, "failed")
  assert.equal(failed.output, "")
  await run({ task: "writer", tools: ["read"] }, signal, 1_000)

  assert.equal(classifications.length, 4)
  assert.deepEqual(classifications[2]?.subject, {
    task: "writer",
    tools: ["read"],
  })
  const evidence = classifications[2]?.evidence?.join("\n") ?? ""
  assert.match(
    evidence,
    /typed live workflow wf-9: terminalStatus=not-attested/,
  )
  assert.match(evidence, /typed settled child wf-9#1: status=failed/)
  assert.doesNotMatch(evidence, /source unavailable|reviewer_error|findings/)
})

test("live audit evidence is bounded metadata, not child prose or a terminal verdict", () => {
  const children = Array.from({ length: 70 }, (_, index): ChildAudit => ({
    index: index + 1,
    task: "untrusted task",
    tools: ["read"],
    startedAt: 1,
    finishedAt: 2,
    status: "failed",
    usageTokens: 1,
    outputCharacters: 5_000,
    retainedOutput: "x".repeat(2_000),
    reason: "untrusted reason",
  }))
  const evidence = workflowAuditEvidence(emptyWorkflowAuditState, {
    id: "wf-9",
    children,
  })
  assert.equal(evidence.length, 65)
  assert.match(
    evidence[0] ?? "",
    /terminalStatus=not-attested; settled=70; shown=64/,
  )
  assert.match(evidence[1] ?? "", /child wf-9#7: status=failed/)
  assert.match(evidence[64] ?? "", /child wf-9#70: status=failed/)
  assert.doesNotMatch(evidence.join("\n"), /untrusted|x{10}|state=completed/)
})

test("foreground and background runners each supply workflow-local settled audits", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  assert.ok(
    /workflowEvidence: \(\) =>\s*workflowAuditEvidence\(emptyWorkflowAuditState, \{\s*id,\s*children: childAudits/.test(
      source,
    ),
  )
  assert.ok(
    /workflowEvidence: \(\) =>\s*workflowAuditEvidence\(emptyWorkflowAuditState, \{\s*id: auditId,\s*children: childAudits/.test(
      source,
    ),
  )
})
