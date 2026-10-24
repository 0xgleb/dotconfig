import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import type { Decision } from "./core.ts"
import {
  resolveActionDecision,
  type BlockedAction,
  type ClassificationRequest,
} from "./lifecycle.ts"
import { runtimeClassificationProjectContextsMatch } from "./project-context.ts"
import {
  terminalWorkflowFailureDisprovesOwnershipBlock,
  type WorkflowAuditState,
} from "./workflow-audit.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const helpersStart = source.indexOf("  const refreshWorkflowAudits =")
const helpersEnd = source.indexOf(
  "  const startBackgroundWorkflow =",
  helpersStart,
)
const actionStart = source.indexOf(
  '    if (decision.verdict === "block") {',
  source.indexOf("    const currentActionProjectContexts ="),
)
const actionEnd = source.indexOf(
  '    if (event.toolName === "bash") {\n      const hardenedPush',
  actionStart,
)
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart)
assert.ok(actionStart >= 0 && actionEnd > actionStart)

const firstDecision: Decision = {
  verdict: "block",
  source: "classifier",
  reason: "wf-7 already owns the requested workflow",
}
const allow: Decision = {
  verdict: "allow",
  source: "classifier",
  reason: "fresh full assessment allows the bounded task",
}

const harness = (
  state:
    | "settled"
    | "running-child"
    | "missing-live-state"
    | "invalid-child-key"
    | "full-cohort"
    | "oversized-cohort"
    | "mismatched-finish"
    | "invalid-time"
    | "audit-child-mismatch"
    | "late-child"
    | "no-signal",
  secondDecision: Decision,
  decision: Decision = firstDecision,
  drift?: "project" | "children" | "cancel" | "gate",
) => {
  const settled = state !== "running-child"
  const child = {
    index: 1,
    status: settled ? "failed" : "running",
    startedAt: 10,
    ...(settled ? { finishedAt: state === "late-child" ? 21 : 19 } : {}),
  }
  const indices =
    state === "full-cohort" || state === "oversized-cohort"
      ? Array.from(
          { length: state === "full-cohort" ? 64 : 65 },
          (_, index) => index + 1,
        )
      : [1]
  const progress = {
    purpose: "synthetic review",
    started: new Set(indices),
    running: new Set(settled ? [] : indices),
    completed: new Set<number>(),
    failed: new Set(settled ? indices : []),
    children: new Map(
      indices.map(index => [
        state === "invalid-child-key" ? 2 : index,
        { ...child, index },
      ]),
    ),
  }
  const workflow = {
    id: "wf-7",
    status: "failed",
    startedAt: 10,
    finishedAt:
      state === "mismatched-finish" ? 21 : state === "invalid-time" ? 5 : 20,
    liveProgress: progress,
  }
  const backgroundWorkflows = new Map(
    state === "missing-live-state" ? [] : [["wf-7", workflow]],
  )
  const auditState: WorkflowAuditState = {
    workflows: [
      {
        id: "wf-7",
        label: "synthetic review",
        status: "failed",
        startedAt: 10,
        finishedAt: state === "invalid-time" ? 5 : 20,
        limits: {
          maxAgents: 1,
          concurrency: 1,
          agentTimeoutMs: 1000,
          workflowTimeoutMs: 2000,
          retries: 0,
          tokenBudget: 8000,
        },
        children: settled
          ? indices.map(index => ({
              index: state === "audit-child-mismatch" ? 99 : index,
              tools: ["read"],
              startedAt: 10,
              finishedAt: state === "late-child" ? 21 : 19,
              status: "failed",
              usageTokens: 2,
              outputCharacters: 0,
              reason: "synthetic failure",
            }))
          : [],
      },
    ],
  }
  const controller = new AbortController()
  const originalContext = { runtimeProjectContext: { cwd: "/synthetic" } }
  let currentContext = originalContext
  let gate = "active"
  const requests: ClassificationRequest[] = []
  let starts = 0
  const event = { toolName: "workflow", input: { code: "return 1;" } }
  const actionRequest: ClassificationRequest = {
    boundary: "action",
    intent: ["Only the independently authorized bounded review."],
    projectInstructions: "Preserve all independent prohibitions.",
    evidence: ["original evidence"],
    subject: event,
  }
  const run: () => Promise<BlockedAction | undefined> = new Function(
    "dependencies",
    `
    const { decision, event, ctx, actionRequest, buildActionRequest, actionProjectContexts,
      backgroundWorkflows, classifyWithActivity, persistReviewWorkflowStart, createHash,
      terminalWorkflowFailureDisprovesOwnershipBlock, resolveActionDecision,
      runtimeClassificationProjectContexts, runtimeClassificationProjectContextsMatch } = dependencies;
    let workflowAudits = dependencies.auditState;
    const currentHumanContinuationDisprovesSpecScopeBlock = () => false;
    const currentInstructionReadDisprovesMissingReadBlock = () => false;
    const resourcePreflightDisprovesBlock = () => false;
    const resourcePreflight = undefined;
    const reportHeadlessClassifierBlock = () => undefined;
    const remediationForDecision = () => undefined;
    const setPendingActionRemediation = () => undefined;
    const remediationInterruption = () => undefined;
    ${stripTypeScriptTypes(source.slice(helpersStart, helpersEnd))}
    ${stripTypeScriptTypes(`const handler = async () => { ${source.slice(actionStart, actionEnd)} };`)}
    return handler;
  `,
  )({
    decision,
    event,
    actionRequest,
    buildActionRequest: () => ({
      ...actionRequest,
      evidence: [...(actionRequest.evidence ?? []), `review gate: ${gate}`],
    }),
    actionProjectContexts: originalContext,
    backgroundWorkflows,
    auditState,
    createHash,
    ctx: {
      cwd: "/synthetic",
      ...(state === "no-signal" ? {} : { signal: controller.signal }),
      sessionManager: { getBranch: () => [] },
    },
    classifyWithActivity: async (request: ClassificationRequest) => {
      requests.push(request)
      if (drift === "project")
        currentContext = { runtimeProjectContext: { cwd: "/changed" } }
      if (drift === "children") progress.running.add(2)
      if (drift === "cancel") controller.abort()
      if (drift === "gate") gate = "revoked"
      return secondDecision
    },
    persistReviewWorkflowStart: () => {
      starts += 1
    },
    terminalWorkflowFailureDisprovesOwnershipBlock,
    resolveActionDecision,
    runtimeClassificationProjectContexts: () => currentContext,
    runtimeClassificationProjectContextsMatch,
  })
  return { run, requests, starts: () => starts, first: decision }
}

test("a terminal parent with a running child cannot clear an ownership block", async () => {
  const fixture = harness("running-child", allow)
  assert.deepEqual(await fixture.run(), resolveActionDecision(firstDecision))
  assert.equal(fixture.requests.length, 0)
  assert.equal(fixture.starts(), 0)
})

test("persisted terminal status without current live-child proof cannot clear a block", async () => {
  const fixture = harness("missing-live-state", allow)
  assert.deepEqual(await fixture.run(), resolveActionDecision(firstDecision))
  assert.equal(fixture.requests.length, 0)
  assert.equal(fixture.starts(), 0)
})

test("a compound refusal remains blocked after one fresh full assessment", async () => {
  const blocked: Decision = {
    verdict: "block",
    source: "classifier",
    reason:
      "wf-7 already owns this task; publication is independently prohibited",
  }
  const fixture = harness("settled", blocked, blocked)
  assert.deepEqual(await fixture.run(), resolveActionDecision(blocked))
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.starts(), 0)
})

test("settled ownership evidence requires an explicit fresh allow and keeps original scope", async () => {
  const fixture = harness("settled", allow)
  assert.equal(await fixture.run(), undefined)
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.starts(), 1)
  const request = fixture.requests[0]
  assert.ok(request)
  assert.deepEqual(request.intent, [
    "Only the independently authorized bounded review.",
  ])
  assert.equal(
    request.projectInstructions,
    "Preserve all independent prohibitions.",
  )
  assert.deepEqual(request.subject, {
    toolName: "workflow",
    input: { code: "return 1;" },
  })
  assert.ok(request.evidence?.includes("original evidence"))
  assert.ok(
    request.evidence?.some(value => value.includes(firstDecision.reason)),
  )
})

for (const state of ["late-child", "no-signal"] as const) {
  test(`${state} retains ordinary bounded reclassification`, async () => {
    const fixture = harness(state, allow)
    assert.equal(await fixture.run(), undefined)
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.starts(), 1)
  })
}

test("inconsistent child identity cannot produce a settlement proof", async () => {
  const fixture = harness("invalid-child-key", allow)
  assert.deepEqual(await fixture.run(), resolveActionDecision(firstDecision))
  assert.equal(fixture.requests.length, 0)
  assert.equal(fixture.starts(), 0)
})

test("a full settled cohort contributes bounded metadata, not child outputs", async () => {
  const fixture = harness("full-cohort", allow)
  assert.equal(await fixture.run(), undefined)
  assert.equal(fixture.requests.length, 1)
  const evidence = fixture.requests[0]?.evidence
  assert.ok(evidence)
  assert.ok(evidence.every(item => item.length <= 1600))
  assert.ok(evidence.some(item => item.includes('"failedChildren":64')))
  assert.ok(evidence.some(item => item.includes('"completedChildren":0')))
})

for (const state of [
  "oversized-cohort",
  "mismatched-finish",
  "invalid-time",
  "audit-child-mismatch",
] as const) {
  test(`${state} cannot qualify an ownership recheck`, async () => {
    const fixture = harness(state, allow)
    assert.deepEqual(await fixture.run(), resolveActionDecision(firstDecision))
    assert.equal(fixture.requests.length, 0)
    assert.equal(fixture.starts(), 0)
  })
}

for (const drift of ["project", "children", "cancel", "gate"] as const) {
  test(`a fresh allow cannot escape ${drift} changes during reclassification`, async () => {
    const fixture = harness("settled", allow, firstDecision, drift)
    const result = await fixture.run()
    assert.equal(result?.block, true)
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.starts(), 0)
  })
}
