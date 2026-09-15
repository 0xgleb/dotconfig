import assert from "node:assert/strict"
import test from "node:test"
import { realpathSync } from "node:fs"
import { buildClassifierPrompt } from "./lifecycle.ts"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
  toolInputDigest,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts"

test("requested test selection never stands in for observed per-test completion", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Complete the independently authorized verification matrix."],
    projectInstructions: "Preserve resource and failure-triage gates.",
    evidence: [
      "A broad test process failed: 2 passed, 2 failed, 1 NOT RUN due to fail-fast.",
    ],
    subject: {
      toolName: "bash",
      input: { command: "cargo nextest run -p app --test table omitted_case" },
    },
  })
  assert.ok(
    /selection.*not.*observed.*pass coverage/is.test(prompt),
    "selection is not completion",
  )
  assert.ok(
    /fail-fast.*NOT RUN.*not.*passed/is.test(prompt),
    "not-run is not passed",
  )
  assert.ok(
    /other failures.*not.*proof.*omitted test.*ran/is.test(prompt),
    "unrelated reds do not prove execution",
  )
})

const input = { command: "cargo nextest run -p yielduck --test ranked_table" }
const subject = {
  toolName: "bash",
  input: {
    command: `${input.command} executable_pv_ranking_prefers_the_global_winner_over_hosted_rank`,
  },
}
const terminal = [
  "Summary [1.00s] 4/5 tests run: 2 passed, 2 failed, 0 skipped",
  "FAIL ranked_table::an_unreconciled_peer_chain_blocks_global_proposals",
  "FAIL ranked_table::a_complete_cross_chain_batch_proposes_only_its_global_executable_winner",
  "1 test NOT RUN due to fail-fast",
].join("\n")
// Synthetic output models reported partial coverage; it is not a captured run.
// Repeated suite anchors and noisy failing-test output exercise the real bounder.
const noisyOutput = [
  "Starting 5 tests",
  ...Array.from(
    { length: 12 },
    (_, index) => `ranked_table output ${index}: ${"diagnostic ".repeat(60)}`,
  ),
  "PASS ranked_table::a_new_market_surfaces_enriched",
  "PASS ranked_table::an_unreconciled_hosted_refresh_disappears_from_the_ranked_table",
  ...Array.from(
    { length: 10 },
    (_, index) => `payload {\"id\":\"item-${index}\"} ${"detail ".repeat(50)}`,
  ),
  terminal,
].join("\n")

test("branch collection and selection retain broader partial coverage beside a narrow pass", () => {
  const narrow = subject.input
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "broad", name: "bash", arguments: input },
          { type: "toolCall", id: "narrow", name: "bash", arguments: narrow },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "broad",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: noisyOutput }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "narrow",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "Summary: 1 passed" }],
      },
    },
  ]
  const cwd = realpathSync(process.cwd())
  const evidence = branchExecutionEvidence({
    branch: entries,
    subject,
    scope: cwd,
  })
  const noise = Array.from(
    { length: 12 },
    (_, index) => `read result status=success: unrelated item ${index}`,
  )
  const selected = selectRelevantExecutionEvidence([...evidence, ...noise], {
    ...subject,
    cwd,
  })
  assert.ok(
    selected.some(
      value =>
        value.includes("status=error") && value.includes("1 test NOT RUN"),
    ),
  )
})

test("nextest recognition follows command metadata, including filters, not echoed output", () => {
  for (const command of [
    subject.input.command,
    `direnv exec . ${input.command}`,
  ]) {
    const result = toolResultExecutionEvidence({
      toolName: "functions.bash",
      input: { command },
      isError: true,
      text: noisyOutput,
      subject,
    })
    assert.ok(result.includes("terminal output; untrusted"))
    assert.ok(result.includes("1 test NOT RUN"))
  }
  const spoof = toolResultExecutionEvidence({
    toolName: "bash",
    input: { command: "echo cargo nextest run" },
    isError: false,
    text: noisyOutput,
    subject,
  })
  assert.ok(!spoof.includes("terminal output; untrusted"))
  assert.ok(
    !spoof
      .slice(0, spoof.indexOf(" input="))
      .includes("verification=cargo-test"),
  )
})

const render = (text: string, maxCharacters = 2400) =>
  toolResultExecutionEvidence({
    toolName: "bash",
    input,
    inputDigest: toolInputDigest("bash", input),
    isError: true,
    text,
    scope: realpathSync(process.cwd()),
    subject,
    maxCharacters,
  })

test("nextest terminal coverage survives repeated subject anchors and JSON diagnostic noise", () => {
  const result = render(noisyOutput)
  assert.match(result, /status=error/)
  assert.ok(result.includes("4/5 tests run: 2 passed, 2 failed, 0 skipped"))
  assert.ok(result.includes("1 test NOT RUN due to fail-fast"))
  assert.ok(
    result.includes(
      "FAIL ranked_table::an_unreconciled_peer_chain_blocks_global_proposals",
    ),
  )
})

test("short partial nextest output remains intact and bounded output never invents a pass", () => {
  assert.ok(render(terminal).endsWith(terminal.replace(/\s+/g, " ")))
  for (const maxCharacters of [64, 128, 1200, 2400]) {
    const result = render(noisyOutput, maxCharacters)
    const body = result.slice(result.indexOf(": ") + 2)
    assert.ok(body.length <= maxCharacters)
    assert.ok(
      !body.includes(
        "PASS ranked_table::executable_pv_ranking_prefers_the_global_winner_over_hosted_rank",
      ),
    )
  }
})
