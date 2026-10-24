import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  runWorkflowScript,
  type AgentRequest,
  type AgentResult,
  type WorkflowLimits,
} from "../pi/extensions/classified-workflows/core.ts"

const skill = readFileSync(
  new URL("../skills/review-core/SKILL.md", import.meta.url),
  "utf8",
)
const script = [...skill.matchAll(/```javascript\n([\s\S]*?)\n```/g)]
  .map(match => match[1])
  .find(block => block && /name:\s*["']review-panel["']/.test(block))
assert.ok(script, "exercise the documented review-panel implementation")

const finding = {
  title: "Failed verification must not become a clean review",
  severity: "high",
  file: "src/review.ts",
  line_start: 10,
  line_end: 12,
  category: "correctness",
  finding: "The review omits unavailable verification evidence.",
  why_it_matters: "A blocked review can appear clean.",
  recommended_fix: "Retain incomplete verification explicitly.",
  confidence: 95,
}
const verdict = {
  verdict: "valid",
  rationale: "The candidate follows the real blocked-result path.",
  severity: "high",
  confidence: 100,
}
const completed = (value: unknown): AgentResult => ({
  status: "completed",
  output: JSON.stringify(value),
  usageTokens: 1,
})
const blocked: AgentResult = {
  status: "blocked",
  output: "",
  reason: "Verification requires unavailable source evidence",
  usageTokens: 0,
}
const limits: WorkflowLimits = {
  maxAgents: 3,
  concurrency: 1,
  agentTimeoutMs: 1_000,
  workflowTimeoutMs: 5_000,
  retries: 0,
  tokenBudget: 240_000,
}
type Stage = "review" | "optional" | "verify" | "synthesis"
type AgentResponse = AgentResult | ((request: AgentRequest) => AgentResult)
const stageOf = (request: AgentRequest): Stage => {
  if (request.task.startsWith("Use Bash to run external")) return "optional"
  if (request.task.includes("adversarially verifying")) return "verify"
  if (request.task.includes("writing the canonical report")) return "synthesis"
  assert.ok(request.task.startsWith("Read the review instructions"))
  return "review"
}
const args = {
  repoRoot: "/fixture",
  docsPaths: ["/fixture/AGENTS.md"],
  lanes: [
    {
      key: "native-reviewer",
      promptPath: "/fixture/review.txt",
      diffPath: "/fixture/diff.patch",
    },
  ],
  reportHeader: "Fixture review",
  sourceAccess: "Fixture source is supplied at the agent boundary.",
  includeAttribution: false,
}
type ExternalLane = (typeof args.lanes)[number] & { externalCmd: string }
const runReview = async (
  overrides: Partial<Record<Stage, AgentResponse>> = {},
  calls: Stage[] = [],
  extraLanes: ExternalLane[] = [],
) => {
  const results: Record<Stage, AgentResponse> = {
    review: completed({ findings: [finding] }),
    optional: completed({ findings: [] }),
    verify: completed(verdict),
    synthesis: completed({ report_markdown: "One verified finding." }),
    ...overrides,
  }
  const input = { ...args, lanes: [...args.lanes, ...extraLanes] }
  const report = await runWorkflowScript(
    `const args = ${JSON.stringify(input)};\n${script}`,
    limits,
    {
      // Only the agent boundary is simulated; no provider or foreign work runs.
      // The real sandbox handles schema-backed results and blocked envelopes.
      availableMemoryBytes: () => Number.MAX_SAFE_INTEGER,
      runAgent: async request => {
        const stage = stageOf(request)
        calls.push(stage)
        const response = results[stage]
        return typeof response === "function" ? response(request) : response
      },
      checkpoint: async () => "approved",
    },
  )
  assert.ok(typeof report === "object" && report !== null)
  return { report, calls }
}

test("blocked verification retains its candidate and prevents clean synthesis", async () => {
  const { report, calls } = await runReview({ verify: blocked })
  assert.deepEqual(calls, ["review", "verify"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("report" in report)
  assert.equal(report.report, null)
  assert.ok("verificationErrors" in report)
  assert.match(
    JSON.stringify(report.verificationErrors),
    /unavailable source evidence/,
  )
  assert.match(JSON.stringify(report.verificationErrors), /src\/review\.ts/)
})

test("a blocked required reviewer cannot become an empty clean review", async () => {
  const { report, calls } = await runReview({ review: blocked })
  assert.deepEqual(calls, ["review"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("laneErrors" in report)
  assert.match(JSON.stringify(report.laneErrors), /unavailable source evidence/)
})

for (const status of ["failed", "timed-out"] as const) {
  test(`${status} schema verification still rejects before synthesis`, async () => {
    const calls: Stage[] = []
    await assert.rejects(
      runReview(
        {
          verify: {
            status,
            output: "",
            reason: "Provider unavailable",
            usageTokens: 0,
          },
        },
        calls,
      ),
      new RegExp(`structured agent ${status}: Provider unavailable`),
    )
    assert.deepEqual(calls, ["review", "verify"])
  })
}

test("successful verification preserves findings and the canonical report", async () => {
  const { report, calls } = await runReview()
  assert.ok("status" in report)
  assert.equal(report.status, "completed")
  assert.deepEqual(calls, ["review", "verify", "synthesis"])
  assert.ok("findings" in report)
  assert.match(JSON.stringify(report.findings), /Failed verification/)
  assert.ok("report" in report)
  assert.equal(report.report, "One verified finding.")
})

test("blocked synthesis is incomplete rather than a missing clean report", async () => {
  const { report } = await runReview({ synthesis: blocked })
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("synthesisError" in report)
  assert.equal(report.synthesisError, blocked.reason)
  assert.ok("report" in report)
  assert.equal(report.report, null)
})

test("blocked optional Claude evidence does not invalidate a complete native review", async () => {
  const { report } = await runReview(
    { optional: blocked },
    [],
    [
      {
        key: "optional-claude",
        promptPath: "/fixture/optional.txt",
        diffPath: "/fixture/diff.patch",
        externalCmd: "fixture-only-command-never-executed",
      },
    ],
  )
  assert.ok("status" in report)
  assert.equal(report.status, "completed")
  assert.ok("laneErrors" in report)
  assert.match(JSON.stringify(report.laneErrors), /optional-claude/)
  assert.match(JSON.stringify(report.laneErrors), /unavailable source evidence/)
  assert.ok("report" in report)
  assert.equal(report.report, "One verified finding.")
})

test("partial verification preserves both verified and blocked candidates", async () => {
  const { report, calls } = await runReview({
    review: completed({
      findings: [finding, { ...finding, file: "src/second.ts" }],
    }),
    verify: request =>
      request.task.includes("src/second.ts") ? blocked : completed(verdict),
  })
  assert.deepEqual(calls, ["review", "verify", "verify"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("findings" in report && Array.isArray(report.findings))
  assert.equal(report.findings.length, 1)
  assert.match(JSON.stringify(report.findings), /src\/review\.ts/)
  assert.ok(
    "unverifiedFindings" in report && Array.isArray(report.unverifiedFindings),
  )
  assert.equal(report.unverifiedFindings.length, 1)
  assert.match(JSON.stringify(report.unverifiedFindings), /src\/second\.ts/)
  assert.ok("report" in report)
  assert.equal(report.report, null)
})

test("a successful zero-candidate review may still complete cleanly", async () => {
  const { report, calls } = await runReview({
    review: completed({ findings: [], clean_reason: "No defects found." }),
    synthesis: completed({ report_markdown: "No findings." }),
  })
  assert.ok("status" in report)
  assert.equal(report.status, "completed")
  assert.deepEqual(calls, ["review", "synthesis"])
  assert.ok("findings" in report && Array.isArray(report.findings))
  assert.equal(report.findings.length, 0)
})
