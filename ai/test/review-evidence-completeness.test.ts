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
type ReviewLane = (typeof args.lanes)[number] & { externalCmd?: string }
const runReview = async (
  overrides: Partial<Record<Stage, AgentResponse>> = {},
  calls: Stage[] = [],
  extraLanes: ReviewLane[] = [],
  options: {
    tierModels?: { light: string; mid: string }
    sourceRevision?: string
    reviewLanes?: ReviewLane[]
    workflowLimits?: WorkflowLimits
    inspectRequest?: (request: AgentRequest) => void
  } = {},
) => {
  const results: Record<Stage, AgentResponse> = {
    review: completed({ findings: [finding] }),
    optional: completed({ findings: [] }),
    verify: completed(verdict),
    synthesis: completed({ report_markdown: "One verified finding." }),
    ...overrides,
  }
  const input = {
    ...args,
    lanes: options.reviewLanes ?? [...args.lanes, ...extraLanes],
    tierModels: options.tierModels,
    sourceRevision: options.sourceRevision,
  }

  const report = await runWorkflowScript(
    `const args = ${JSON.stringify(input)};\n${script}`,
    options.workflowLimits ?? limits,
    {
      // Only the agent boundary is simulated; no provider or foreign work runs.
      // The real sandbox handles schema-backed results and blocked envelopes.
      availableMemoryBytes: () => Number.MAX_SAFE_INTEGER,
      runAgent: async request => {
        options.inspectRequest?.(request)
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

test("legacy external-command metadata stays native and its blocked lane remains required", async () => {
  const { report, calls } = await runReview(
    {
      review: request =>
        request.task.includes("/fixture/legacy.txt")
          ? blocked
          : completed({ findings: [finding] }),
    },
    [],
    [
      {
        key: "legacy-reviewer",
        promptPath: "/fixture/legacy.txt",
        diffPath: "/fixture/diff.patch",
        externalCmd: "fixture-only-command-never-executed",
      },
    ],
    {
      inspectRequest: request => {
        assert.equal(request.model, "openai-codex/gpt-6.1-sol")
        assert.doesNotMatch(request.task, /Use Bash to run external/)
        assert.doesNotMatch(request.task, /fixture-only-command/)
      },
    },
  )

  assert.deepEqual(calls, ["review", "review"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("laneErrors" in report)
  assert.match(JSON.stringify(report.laneErrors), /legacy-reviewer/)
  assert.match(JSON.stringify(report.laneErrors), /unavailable source evidence/)
  assert.ok("report" in report)
  assert.equal(report.report, null)
})

test("review, verification and synthesis keep GPT-6.1-sol despite caller tier overrides", async () => {
  const models: (string | undefined)[] = []
  const { report, calls } = await runReview({}, [], [], {
    tierModels: { light: "foreign/light", mid: "foreign/mid" },
    inspectRequest: request => {
      assert.equal(request.model, "openai-codex/gpt-6.1-sol")
      models.push(request.model)
    },
  })

  assert.deepEqual(calls, ["review", "verify", "synthesis"])
  assert.equal(models.length, 3)
  assert.ok("status" in report)
  assert.equal(report.status, "completed")
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

for (const [name, alternative] of [
  [
    "different failure mechanism",
    {
      ...finding,
      title: "Reconciliation loses a committed event",
      finding: "A durable event is omitted from the projection.",
      why_it_matters: "Committed state and the displayed balance diverge.",
      recommended_fix:
        "Replay the missing event before publishing the projection.",
    },
  ],
  [
    "different repair",
    {
      ...finding,
      recommended_fix: "Return incomplete before entering synthesis.",
    },
  ],
  ["different anchor", { ...finding, line_start: 14, line_end: 16 }],
] as const) {
  test(`nearby candidates retain independent verification for a ${name}`, async () => {
    const { report, calls } = await runReview({
      review: completed({ findings: [finding, alternative] }),
    })

    assert.deepEqual(calls, ["review", "verify", "verify", "synthesis"])
    assert.ok("status" in report)
    assert.equal(report.status, "completed")
    assert.ok("findings" in report && Array.isArray(report.findings))
    assert.deepEqual(
      report.findings,
      [finding, alternative].map(candidate => ({
        ...candidate,
        ...verdict,
        found_by: ["native-reviewer"],
        diff_path: "/fixture/diff.patch",
      })),
    )
  })
}

test("identical findings merge without losing reviewer attribution", async () => {
  const { report, calls } = await runReview(
    {},
    [],
    [
      {
        key: "second-reviewer",
        promptPath: "/fixture/second.txt",
        diffPath: "/fixture/diff.patch",
      },
    ],
  )

  assert.deepEqual(calls, ["review", "review", "verify", "synthesis"])
  assert.ok("findings" in report && Array.isArray(report.findings))
  assert.equal(report.findings.length, 1)

  const sole: unknown = report.findings[0]
  assert.ok(typeof sole === "object" && sole !== null && "found_by" in sole)
  assert.deepEqual(sole.found_by, ["native-reviewer", "second-reviewer"])
})

test("synthesis receives every unique scoped diff, not only the first chunk", async () => {
  let synthesisRequests = 0

  const { report } = await runReview(
    {},
    [],
    [
      {
        key: "second-chunk",
        promptPath: "/fixture/second-chunk.txt",
        diffPath: "/fixture/second-chunk.patch",
      },
    ],
    {
      inspectRequest: request => {
        if (stageOf(request) !== "synthesis") return

        synthesisRequests += 1
        assert.ok(request.task.includes("/fixture/diff.patch"))
        assert.ok(request.task.includes("/fixture/second-chunk.patch"))
        assert.match(request.task, /Read every scoped diff/)
      },
    },
  )

  assert.ok("status" in report)
  assert.equal(report.status, "completed")
  assert.equal(synthesisRequests, 1)
})

test("synthesis is instructed to report verified findings, not discover new ones", async () => {
  let synthesisRequests = 0

  const { report } = await runReview({}, [], [], {
    inspectRequest: request => {
      if (stageOf(request) !== "synthesis") return

      synthesisRequests += 1
      assert.match(request.task, /Only report the supplied verified findings/)
      assert.doesNotMatch(
        request.task,
        /call out anything the reviewers collectively missed/,
      )
    },
  })

  assert.ok("status" in report)
  assert.equal(report.status, "completed")
  assert.equal(synthesisRequests, 1)
})

test("no required reviewers cannot become a completed review", async () => {
  const { report, calls } = await runReview({}, [], [], { reviewLanes: [] })

  assert.deepEqual(calls, [])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("laneErrors" in report)
  assert.match(JSON.stringify(report.laneErrors), /required review lanes/i)
  assert.ok("report" in report)
  assert.equal(report.report, null)
})

test("an unexplained empty reviewer result cannot certify source coverage", async () => {
  const { report, calls } = await runReview({ review: completed({ findings: [] }) })

  assert.deepEqual(calls, ["review"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("laneErrors" in report)
  assert.match(JSON.stringify(report.laneErrors), /clean_reason/)
})

test("reviewer evidence errors retain candidates without advancing", async () => {
  const { report, calls } = await runReview({
    review: completed({
      findings: [finding],
      reviewer_error: "Unread spec/required.md",
    }),
  })

  assert.deepEqual(calls, ["review"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("unverifiedFindings" in report)
  assert.match(JSON.stringify(report.unverifiedFindings), /src\/review\.ts/)
  assert.ok("laneErrors" in report)
  assert.match(JSON.stringify(report.laneErrors), /spec\/required\.md/)
})

for (const response of [
  { verdict: "incomplete", rationale: "Unread spec/required.md" },
  { ...verdict, evidence_error: "Unread spec/required.md" },
]) {
  test(`verifier evidence incompleteness preserves its candidate (${response.verdict})`, async () => {
    const { report, calls } = await runReview({ verify: completed(response) })

    assert.deepEqual(calls, ["review", "verify"])
    assert.ok("status" in report)
    assert.equal(report.status, "incomplete")
    assert.ok("verificationErrors" in report)
    assert.match(
      JSON.stringify(report.verificationErrors),
      /spec\/required\.md/,
    )
    assert.ok("unverifiedFindings" in report)
    assert.match(JSON.stringify(report.unverifiedFindings), /src\/review\.ts/)
    assert.ok("report" in report)
    assert.equal(report.report, null)
  })
}

for (const [name, scores] of [
  ["missing", {}],
  ["negative confidence", { severity: "high", confidence: -1 }],
  ["confidence above 100", { severity: "high", confidence: 101 }],
] as const) {
  test(`a substantive verdict with ${name} scores remains unverified`, async () => {
    const { report } = await runReview({
      verify: completed({
        verdict: "valid",
        rationale: "Read the source.",
        ...scores,
      }),
    })

    assert.ok("status" in report)
    assert.equal(report.status, "incomplete")
    assert.ok("verificationErrors" in report)
    assert.match(JSON.stringify(report.verificationErrors), /scores/i)
    assert.ok("unverifiedFindings" in report)
    assert.match(JSON.stringify(report.unverifiedFindings), /src\/review\.ts/)
  })
}

test("a substantive verifier result without rationale remains unverified", async () => {
  const { report, calls } = await runReview({
    verify: completed({ ...verdict, rationale: "   " }),
  })

  assert.deepEqual(calls, ["review", "verify"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("verificationErrors" in report)
  assert.match(JSON.stringify(report.verificationErrors), /rationale/)
})

test("synthesis evidence errors retain verified findings but no complete report", async () => {
  const { report, calls } = await runReview({
    synthesis: completed({ evidence_error: "Unread second-chunk.patch" }),
  })

  assert.deepEqual(calls, ["review", "verify", "synthesis"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("synthesisError" in report)
  assert.equal(report.synthesisError, "Unread second-chunk.patch")
  assert.ok("findings" in report && Array.isArray(report.findings))
  assert.equal(report.findings.length, 1)
  assert.ok("report" in report)
  assert.equal(report.report, null)
})

test("an empty synthesis result cannot certify completion", async () => {
  const { report } = await runReview({ synthesis: completed({}) })

  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("synthesisError" in report)
  assert.match(JSON.stringify(report.synthesisError), /report/i)
  assert.ok("report" in report)
  assert.equal(report.report, null)
})

for (const sourceRevision of [undefined, "a".repeat(40)]) {
  test(`every phase receives source-safety and evidence instructions (${sourceRevision ? "revision" : "working tree"})`, async () => {
    const seen: Stage[] = []
    await runReview({}, [], [], {
      sourceRevision,
      inspectRequest: request => {
        const stage = stageOf(request)
        seen.push(stage)
        assert.match(request.task, /Never read/)
        assert.match(request.task, /credential stores/)
        assert.match(request.task, /path-scoped/)
        assert.match(
          request.task,
          stage === "review" ? /reviewer_error/ : /evidence_error/,
        )
      },
    })

    assert.deepEqual(seen, ["review", "verify", "synthesis"])
  })
}

test("all verdict partitions retain exact candidate membership", async () => {
  const tags = [
    "valid",
    "likely",
    "disputed",
    "invalid",
    "out-of-scope",
  ] as const
  const candidates = tags.map(tag => ({ ...finding, file: `src/${tag}.ts` }))
  const { report } = await runReview(
    {
      review: completed({ findings: candidates }),
      verify: request => {
        const tag = tags.find(value => request.task.includes(`src/${value}.ts`))
        assert.ok(tag)
        return completed({ ...verdict, verdict: tag })
      },
    },
    [],
    [],
    { workflowLimits: { ...limits, maxAgents: 16, tokenBudget: 1_280_000 } },
  )

  const expected = tags.map(tag => ({
    ...finding,
    file: `src/${tag}.ts`,
    ...verdict,
    verdict: tag,
    found_by: ["native-reviewer"],
    diff_path: "/fixture/diff.patch",
  }))
  assert.ok("findings" in report)
  assert.deepEqual(report.findings, expected.slice(0, 3))
  assert.ok("dismissed" in report)
  assert.deepEqual(report.dismissed, expected.slice(3))
})

test("oversized synthesis preserves verified evidence without an oversized agent task", async () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    ...finding,
    file: `src/large-${index}.ts`,
    finding: "Detailed source evidence. ".repeat(60),
  }))
  const { report, calls } = await runReview(
    {
      review: completed({ findings: candidates }),
    },
    [],
    [],
    { workflowLimits: { ...limits, maxAgents: 16, tokenBudget: 1_280_000 } },
  )

  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.equal(calls.filter(stage => stage === "verify").length, 40)
  assert.equal(calls.includes("synthesis"), false)
  assert.ok("findings" in report && Array.isArray(report.findings))
  assert.equal(report.findings.length, 40)
  assert.ok("resourceError" in report)
  assert.match(JSON.stringify(report.resourceError), /synthesis.*32,000/i)
})

test("mandatory review batches reserve a phase for synthesis before starting", async () => {
  const reviewLanes = Array.from({ length: 241 }, (_, index) => ({
    key: `review-${index}`,
    promptPath: `/fixture/review-${index}.txt`,
    diffPath: "/fixture/diff.patch",
  }))
  const { report, calls } = await runReview({}, [], [], {
    reviewLanes,
    workflowLimits: { ...limits, maxAgents: 16, tokenBudget: 1_280_000 },
  })

  assert.deepEqual(calls, [])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok("resourceError" in report)
  assert.match(JSON.stringify(report.resourceError), /16-phase/)
})

test("phase exhaustion retains candidates before entering an impossible verification batch", async () => {
  const candidates = Array.from({ length: 225 }, (_, index) => ({
    ...finding,
    file: `src/phase-${index}.ts`,
  }))
  const { report, calls } = await runReview(
    {
      review: completed({ findings: candidates }),
    },
    [],
    [],
    { workflowLimits: { ...limits, maxAgents: 16, tokenBudget: 1_280_000 } },
  )

  assert.deepEqual(calls, ["review"])
  assert.ok("status" in report)
  assert.equal(report.status, "incomplete")
  assert.ok(
    "unverifiedFindings" in report && Array.isArray(report.unverifiedFindings),
  )
  assert.equal(report.unverifiedFindings.length, 225)
  assert.ok("resourceError" in report)
  assert.match(JSON.stringify(report.resourceError), /phase/i)
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
