import assert from "node:assert/strict"
import test from "node:test"
import { buildClassifierPrompt } from "./lifecycle.ts"
import { workflowAuditEvidence, type WorkflowAudit } from "./workflow-audit.ts"

const assertContract = (prompt: string, pattern: RegExp): void =>
  assert.ok(
    pattern.test(prompt),
    `Missing classifier contract: ${pattern.source}`,
  )

const audit = (status: WorkflowAudit["status"]): WorkflowAudit => ({
  id: "wf-7",
  label: "bounded source review",
  status,
  startedAt: 10,
  finishedAt: 20,
  limits: {
    maxAgents: 1,
    concurrency: 1,
    agentTimeoutMs: 1_000,
    workflowTimeoutMs: 2_000,
    retries: 0,
    tokenBudget: 8_000,
  },
  children: [
    {
      index: 1,
      tools: ["read"],
      startedAt: 10,
      finishedAt: 19,
      status: "completed",
      usageTokens: 10,
      outputCharacters: 7,
      retainedOutput: "finding",
    },
  ],
  outcome: "review coverage incomplete",
})

for (const status of ["failed", "cancelled", "completed"] as const) {
  test(`classifier prompt separates a ${status} workflow's assessment from live ownership`, () => {
    const prompt = buildClassifierPrompt({
      boundary: "action",
      intent: [
        "Implement the independently authorized type-only prerequisite.",
      ],
      projectInstructions:
        "Types, compile, behavioral RED, then implementation. Preserve unrelated work.",
      evidence: workflowAuditEvidence({ workflows: [audit(status)] }),
      subject: {
        toolName: "write",
        input: {
          path: "src/gate.ts",
          content: "export interface Witness { readonly id: string }",
        },
      },
    })
    assert.ok(prompt.includes(`typed workflow audit: wf-7 status=${status}`))
    assert.ok(prompt.includes("review coverage incomplete"))
    assertContract(
      prompt,
      /A terminal workflow audit is execution-state evidence, not a live ownership lease\./,
    )
    assertContract(
      prompt,
      /same-session workflow identity and evidence that all of its children have settled/i,
    )
    assertContract(
      prompt,
      /incomplete assessment or missing checkpoint does not make settled execution active/i,
    )
    assertContract(
      prompt,
      /apply this distinction to ordinary source actions as well as new workflow launches/i,
    )
  })
}

test("classifier prompt preserves completed evidence and independent gates", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Verify only the newly changed source after an authorized fix."],
    projectInstructions:
      "Do not duplicate a live worker, expose secrets, or publish without authority.",
    evidence: workflowAuditEvidence({ workflows: [audit("completed")] }),
    subject: {
      toolName: "workflow",
      input: { code: "return await agent('verify changed source');" },
    },
  })
  assertContract(
    prompt,
    /retain usable completed child evidence and reject unchanged duplicate work/i,
  )
  assertContract(
    prompt,
    /a running child or newer active successor retains its actual delegated scope/i,
  )
  assertContract(
    prompt,
    /A terminal status alone does not prove that every child has stopped/i,
  )
  assertContract(
    prompt,
    /does not grant mutation, TTDD, review, publication, or secret-access authority/i,
  )
  assertContract(
    prompt,
    /do not transfer workflow identifiers or state between sessions/i,
  )
})
