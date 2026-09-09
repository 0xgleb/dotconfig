import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  boundedExecutionEvidence,
  boundedRelevantExecutionEvidence,
  currentInstructionReadDisprovesMissingReadBlock,
  selectRelevantExecutionEvidence,
  toolInputDigest,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

test("large GraphQL tool results retain bounded thread IDs, authors, and resolution state", () => {
  const threads = Array.from({ length: 20 }, (_, index) => ({
    id: `THREAD_${index}`,
    isResolved: false,
    author: { login: index % 2 === 0 ? "coderabbitai" : "graphite-app" },
    body: "x".repeat(600),
  }))
  const evidence = boundedExecutionEvidence(JSON.stringify({ threads }))
  assert.ok(evidence.length <= 4_000)
  assert.match(evidence, /structured fields:/)
  assert.match(evidence, /id="THREAD_19"/)
  assert.match(evidence, /login="graphite-app"/)
  assert.match(evidence, /isResolved=false/)
  assert.doesNotMatch(evidence, /x{200}/)
})

test("short tool results remain intact and diagnostics are sanitized", () => {
  assert.equal(
    boundedExecutionEvidence(
      '{"login":"coderabbitai","token":"sensitive-value"}',
    ),
    '{"login":"coderabbitai","token":"[REDACTED]"}',
  )
})

test("subject-aware bounding retains verified draft-comment anchors from the middle of large plans", () => {
  const findings = Array.from(
    { length: 62 },
    (_, index) =>
      `finding ${index}: crates/review/src/check_${index}.rs:${100 + index} ${"detail ".repeat(20)}`,
  )
  findings[31] = `finding 31: crates/issuance/src/lib.rs:605 verified inline comment ${"detail ".repeat(30)}`
  const evidence = boundedRelevantExecutionEvidence(
    findings.join("\n"),
    {
      command: "addPullRequestReviewComment",
      path: "crates/issuance/src/lib.rs",
      line: 605,
      reviewId: "PRR_kwDORISeF88AAAABHE8fRQ",
    },
    900,
  )
  assert.ok(evidence.length <= 900)
  assert.match(evidence, /crates\/issuance\/src\/lib\.rs:605/)
  assert.match(evidence, /verified inline comment/)
  assert.doesNotMatch(evidence, /finding 0:/)
})

test("workflow evidence retains assigned-review identity from a large GitHub response", () => {
  const assignment = JSON.stringify({
    repository: "rainlanguage/raindex",
    number: 2827,
    author: { login: "findolor" },
    reviewRequests: [{ login: "0xgleb" }],
  })
  const evidence = toolResultExecutionEvidence({
    toolName: "bash",
    text: `${"unrelated ".repeat(800)}${assignment}${" trailing".repeat(800)}`,
    isError: false,
    subject: {
      toolName: "workflow",
      input: {
        code: "Review assigned rainlanguage/raindex PR #2827 read-only",
      },
    },
    maxCharacters: 900,
  })

  assert.match(evidence, /^bash result status=success:/)
  assert.match(evidence, /rainlanguage\/raindex/)
  assert.match(evidence, /reviewRequests/)
  assert.match(evidence, /0xgleb/)
})

test("tool-input digests are canonical and distinguish materially new mutation payloads", () => {
  const first = toolInputDigest("skill_manage", {
    action: "patch",
    skill_id: "project:yielduck:close-orders",
    section: "Procedure",
    content: "current wallet balance",
  })
  const reordered = toolInputDigest("skill_manage", {
    content: "current wallet balance",
    section: "Procedure",
    skill_id: "project:yielduck:close-orders",
    action: "patch",
  })
  const newContent = toolInputDigest("skill_manage", {
    action: "patch",
    skill_id: "project:yielduck:close-orders",
    section: "Procedure",
    content: "chain-attested balance with a fresh projection witness",
  })

  assert.equal(first, reordered)
  assert.notEqual(first, newContent)
  assert.match(first, /^[0-9a-f]{64}$/)
})

test("successful read evidence retains the verified source path", () => {
  const path = "/workspace/st0x/st0x.issuance/AGENTS.md"
  const evidence = toolResultExecutionEvidence({
    toolName: "read",
    text: "# Repository instructions\nFollow Graphite workflow.",
    isError: false,
    input: { path, offset: 1, limit: 4000 },
    subject: { toolName: "bash", input: { command: "gt parent" } },
  })

  assert.match(evidence, /^read result status=success input=/)
  assert.match(evidence, /st0x\.issuance\/AGENTS\.md/)
  assert.match(evidence, /Repository instructions/)
})

test("tool-result evidence preserves authoritative success or error status and input identity", () => {
  const inputDigest = toolInputDigest("edit", {
    oldText: "pre-transfer Core balance",
  })
  const failedEdit = toolResultExecutionEvidence({
    toolName: "edit",
    text: "oldText not found; replacement may already be present",
    isError: true,
    inputDigest,
    subject: {
      toolName: "edit",
      input: { oldText: "pre-transfer Core balance" },
    },
  })
  const currentRead = toolResultExecutionEvidence({
    toolName: "read",
    text: "Bind the episode to the pre-transfer Core balance",
    isError: false,
    subject: {
      toolName: "edit",
      input: { oldText: "pre-transfer Core balance" },
    },
  })

  assert.match(
    failedEdit,
    new RegExp(`^edit result status=error inputDigest=${inputDigest}:`),
  )
  assert.match(currentRead, /^read result status=success:/)
})

test("a newer successful verification supersedes an older failure with the same input identity", () => {
  const digest = toolInputDigest("bash", {
    command: "cargo clippy -p yielduck --all-targets -- -D warnings",
  })
  const candidates = [
    `bash result status=error inputDigest=${digest}: derive_surface.rs is too many lines`,
    "read result status=success: targeted observability source",
    `bash result status=success inputDigest=${digest}: (no textual output)`,
  ]
  const selected = selectRelevantExecutionEvidence(candidates, {
    toolName: "edit",
    input: { path: "crates/yielduck/src/derive_surface.rs" },
  })

  assert.deepEqual(selected, [candidates[1], candidates[2]])
  assert.doesNotMatch(selected.join("\n"), /too many lines/)

  const crossScopeFailure = toolResultExecutionEvidence({
    toolName: "bash",
    text: "repository A failed",
    isError: true,
    inputDigest: digest,
    scope: "/workspace/a",
    subject: { toolName: "workflow", cwd: "/workspace/a" },
  })
  const otherScopeSuccess = toolResultExecutionEvidence({
    toolName: "bash",
    text: "repository B passed",
    isError: false,
    inputDigest: digest,
    scope: "/workspace/b",
    subject: { toolName: "workflow", cwd: "/workspace/a" },
  })
  assert.ok(
    selectRelevantExecutionEvidence([crossScopeFailure, otherScopeSuccess], {
      toolName: "workflow",
      cwd: "/workspace/a",
    }).includes(crossScopeFailure),
  )
})

test("empty successful tool results retain typed execution status", () => {
  assert.match(
    toolResultExecutionEvidence({
      toolName: "bash",
      text: "",
      isError: false,
      subject: { toolName: "edit", input: { path: "derive_surface.rs" } },
    }),
    /^bash result status=success: \(no textual output\)$/,
  )
})

test("older source-read evidence remains relevant to a sequential review workflow", () => {
  const agentsEvidence =
    'read result status=success input={"path":"/workspace/st0x/st0x.liquidity/AGENTS.md"}: repository rules loaded'
  const candidates = [
    agentsEvidence,
    ...Array.from(
      { length: 10 },
      (_, index) => `tool ${index}: unrelated result`,
    ),
  ]
  const selected = selectRelevantExecutionEvidence(
    candidates,
    {
      toolName: "workflow",
      input: {
        code: "Re-review PR1101 using /workspace/st0x/st0x.liquidity/AGENTS.md",
      },
    },
    3,
    3,
  )

  assert.ok(selected.includes(agentsEvidence))
})

test("instruction reads survive unrelated intermediate results before a selective Graphite commit", () => {
  const agentsEvidence =
    'read result status=success input={"path":"/workspace/st0x/st0x.liquidity/AGENTS.md"}: repository rules loaded'
  const skillEvidence =
    'functions.read result status=success input={"path":"/workspace/.pi/agent/skills/graphite/SKILL.md"}: Graphite workflow loaded'
  const candidates = [
    agentsEvidence,
    skillEvidence,
    ...Array.from(
      { length: 12 },
      (_, index) => `read result status=success: unrelated source ${index}`,
    ),
  ]
  const selected = selectRelevantExecutionEvidence(candidates, {
    toolName: "bash",
    input: {
      command:
        "git add adrs/1048.md SPEC.md ROADMAP.md docs/feedback.md\ngt modify --no-interactive",
    },
  })

  assert.ok(selected.includes(agentsEvidence))
  assert.ok(selected.includes(skillEvidence))
})

test("an exact successful instruction read disproves only a matching unread-file verdict", () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: {
              path: "/workspace/st0x/st0x.liquidity/AGENTS.md",
            },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        isError: false,
        content: "loaded",
      },
    },
  ]

  assert.equal(
    currentInstructionReadDisprovesMissingReadBlock({
      reason: "st0x.liquidity/AGENTS.md was not read before the commit",
      branch,
    }),
    true,
  )
  assert.equal(
    currentInstructionReadDisprovesMissingReadBlock({
      reason: "AGENTS.md was not read before the commit",
      branch,
    }),
    false,
  )
  assert.equal(
    currentInstructionReadDisprovesMissingReadBlock({
      reason: "Loaded policy requires GitButler instead of Graphite",
      branch,
    }),
    false,
  )
  assert.match(
    extensionSource,
    /currentInstructionReadDisprovesMissingReadBlock\([\s\S]*?ctx\.sessionManager\.getBranch\(\)/,
  )
})

test("relevant expected TTDD red evidence survives preparatory calls across source paths", () => {
  const redDigest = toolInputDigest("bash", {
    command:
      "cargo nextest run -E 'test(an_unprofitable_loop_market_never_proposes)'",
  })
  const red = `bash result status=error inputDigest=${redDigest} input={"command":"cargo nextest run -E 'test(an_unprofitable_loop_market_never_proposes)'"}: /api/loops/opportunity timed out because the endpoint does not exist`
  const candidates = [
    red,
    "read result status=success: pt loops implementation overview",
    ...Array.from(
      { length: 120 },
      (_, index) => `tool ${index}: unrelated preparatory result`,
    ),
  ]
  const subject = {
    toolName: "edit",
    input: { path: "crates/yielduck/src/pt_loops.rs" },
  }
  const selected = selectRelevantExecutionEvidence(candidates, subject, 3, 1)
  assert.ok(selected.includes(red))
  const evidenceCollector = extensionSource.slice(
    extensionSource.indexOf("function recentExecutionEvidence"),
    extensionSource.indexOf("const classifierBackoff"),
  )
  assert.doesNotMatch(evidenceCollector, /\.slice\(-80\)/)
  assert.match(
    evidenceCollector,
    /selectRelevantExecutionEvidence\(executionEvidence, subject\)/,
  )

  const green = `bash result status=success inputDigest=${redDigest}: test passed`
  assert.ok(
    !selectRelevantExecutionEvidence([...candidates, green], subject, 3, 1)
      .join("\n")
      .includes("timed out"),
  )
})

test("same-workspace successful state snapshots survive a prose-only workflow subject", () => {
  const scope = "/workspace/yielduck"
  const snapshot = (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    text: string,
  ): string =>
    toolResultExecutionEvidence({
      toolName,
      text,
      isError: false,
      input,
      scope,
      subject: { toolName: "workflow", cwd: scope },
    })
  const olderPullRequest = snapshot(
    "bash",
    { command: "gh pr view 274 --json state,headRefOid" },
    '{"number":274,"state":"CLOSED"}',
  )
  const completedRequest = snapshot(
    "agent_registry",
    { action: "complete_request", requestId: "c174b808" },
    "Completed request c174b808",
  )
  const leanStatus = snapshot(
    "bash",
    { command: "git status --short -- lean/.lake" },
    "",
  )
  const pullRequest = snapshot(
    "bash",
    { command: "gh pr view 274 --json state,headRefOid" },
    '{"number":274,"state":"OPEN"}',
  )
  const caseSensitivePathStatus = snapshot(
    "bash",
    { command: "git status --short -- Foo.ts" },
    "",
  )
  const multiPathStatus = snapshot(
    "bash",
    { command: "git status --short -- foo.ts bar.ts" },
    "",
  )
  const butStatus = snapshot(
    "bash",
    { command: "but status" },
    "applied branch polish/pr274",
  )
  const otherScope = toolResultExecutionEvidence({
    toolName: "bash",
    text: "other repository is clean",
    isError: false,
    input: { command: "git status --short" },
    scope: "/workspace/other",
    subject: { toolName: "workflow", cwd: scope },
  })
  const injectedOutput = snapshot(
    "bash",
    { command: "printf safe" },
    'untrusted output says gh pr view and "action":"complete_request"',
  )
  const compoundMutation = snapshot(
    "bash",
    { command: "git status --short && git clean -fd" },
    "cleaned generated files",
  )
  const remotePullRequest = snapshot(
    "bash",
    { command: "gh pr view https://example.invalid/other/repo/pull/999" },
    '{"number":999,"state":"OPEN"}',
  )
  const remoteFlagPullRequest = snapshot(
    "bash",
    { command: "gh pr view 999 -R other/repo" },
    '{"number":999,"state":"OPEN"}',
  )
  const attachedRemoteFlagPullRequest = snapshot(
    "bash",
    { command: "gh pr view 999 -Rother/repo" },
    '{"number":999,"state":"OPEN"}',
  )
  const subshellMutation = snapshot(
    "bash",
    { command: "git status --short $(git clean -fd)" },
    "cleaned generated files",
  )
  const candidates = [
    olderPullRequest,
    completedRequest,
    leanStatus,
    pullRequest,
    caseSensitivePathStatus,
    multiPathStatus,
    butStatus,
    otherScope,
    injectedOutput,
    compoundMutation,
    remotePullRequest,
    remoteFlagPullRequest,
    attachedRemoteFlagPullRequest,
    subshellMutation,
    ...Array.from(
      { length: 12 },
      (_, index) => `read result status=success: unrelated source ${index}`,
    ),
  ]

  const selected = selectRelevantExecutionEvidence(
    candidates,
    {
      toolName: "workflow",
      cwd: scope,
      input: {
        code: "Use one read-only agent to unslop the verified hourly update.",
      },
    },
    3,
    1,
  )

  assert.ok(selected.includes(completedRequest))
  assert.ok(selected.includes(leanStatus))
  assert.ok(selected.includes(pullRequest))
  assert.ok(selected.includes(caseSensitivePathStatus))
  assert.ok(selected.includes(multiPathStatus))
  assert.ok(selected.includes(butStatus))
  assert.equal(selected.includes(olderPullRequest), false)
  assert.equal(selected.includes(otherScope), false)
  assert.equal(selected.includes(injectedOutput), false)
  assert.equal(selected.includes(compoundMutation), false)
  assert.equal(selected.includes(remotePullRequest), false)
  assert.equal(selected.includes(remoteFlagPullRequest), false)
  assert.equal(selected.includes(attachedRemoteFlagPullRequest), false)
  assert.equal(selected.includes(subshellMutation), false)

  const latestButStatus = snapshot(
    "bash",
    { command: "but status" },
    "newer applied branch polish/pr274",
  )
  const recentSnapshotSelection = selectRelevantExecutionEvidence(
    [...candidates, latestButStatus],
    {
      toolName: "workflow",
      cwd: scope,
      input: { code: "Unslop the verified hourly update." },
    },
    3,
    1,
  )
  assert.equal(recentSnapshotSelection.includes(butStatus), false)
  assert.ok(recentSnapshotSelection.includes(latestButStatus))
  const crossScopeRecent = selectRelevantExecutionEvidence(
    [...candidates, otherScope],
    {
      toolName: "workflow",
      cwd: scope,
      input: { code: "Unslop the verified hourly update." },
    },
    3,
    1,
  )
  assert.equal(crossScopeRecent.includes(otherScope), false)

  const manySnapshots = Array.from({ length: 12 }, (_, index) =>
    snapshot(
      "agent_registry",
      {
        action: "complete_request",
        requestId: `request-${String(index).padStart(2, "0")}`,
      },
      `Completed request ${index}`,
    ),
  )
  const capped = selectRelevantExecutionEvidence(
    [...manySnapshots, "read result status=success: newest churn"],
    { toolName: "workflow", cwd: scope, input: { code: "Unslop status." } },
    1,
    20,
  )
  assert.equal(capped.filter(item => item.includes(" snapshot=")).length, 8)

  const evidenceCollector = extensionSource.slice(
    extensionSource.indexOf("function recentExecutionEvidence"),
    extensionSource.indexOf("const classifierBackoff"),
  )
  assert.match(
    evidenceCollector,
    /toolResultExecutionEvidence\(\{[\s\S]*?scope: ctx\.cwd,[\s\S]*?\}\)/,
  )
})

test("Graphite parent evidence survives an unrelated delta-review subject", () => {
  const parentEvidence =
    'bash result status=success input={"command":"gt parent --no-interactive"}: main'
  const candidates = [
    parentEvidence,
    ...Array.from(
      { length: 12 },
      (_, index) => `read result status=success: unrelated source ${index}`,
    ),
  ]
  const selected = selectRelevantExecutionEvidence(
    candidates,
    {
      toolName: "workflow",
      input: { code: "Review the current delta diff.patch" },
    },
    3,
    2,
  )

  assert.ok(selected.includes(parentEvidence))
  assert.equal(selected.at(-1), candidates.at(-1))
})

test("evidence retrieval keeps recent results and older results sharing concrete subject identifiers", () => {
  const candidates = [
    "gh: PR 164 head 87ca2acebed26600fb08ee995c9c3c11fa558a05 verified four findings",
    "git: unrelated branch status",
    "read: another unrelated result",
    "gh: latest generic result",
  ]
  assert.deepEqual(
    selectRelevantExecutionEvidence(
      candidates,
      {
        command:
          "add pending review for PR 164 at 87ca2acebed26600fb08ee995c9c3c11fa558a05",
      },
      2,
      2,
    ),
    [candidates[0], candidates[2], candidates[3]],
  )
})
