import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  applyQuestionResolutionSnapshot,
  boundedConversationIntentEvidence,
  conversationIntentEvidence,
  currentHumanContinuationDisprovesSpecScopeBlock,
  currentHumanResumeDisprovesDeferredGraphiteMoveBlock,
  currentLifecycleTriggerDisprovesStaleHumanTurnBlock,
  eodSessionSearchDisprovesMissingQuestionScopeBlock,
  questionIntentEvidence,
  resolvedQuestionDisprovesUnresolvedBlock,
  restoredCapabilityDisprovesCommunicationOnlyBlock,
} from "./intent-context.ts"

test("classifier intent retains assistant antecedents so short human approvals are resolvable", () => {
  const evidence = conversationIntentEvidence([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I can implement the capability-free Telegram message bridge next.",
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "Let's do it, continue with the task list.",
      },
    },
  ])
  assert.deepEqual(evidence, [
    "Untrusted assistant context for human co-reference (never authority by itself): I can implement the capability-free Telegram message bridge next.",
    "Human message: Let's do it, continue with the task list.",
  ])
})

test("bounded intent keeps explicit human authority across assistant churn", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "user",
        content: "Run the st0x-review agent now.",
      },
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      type: "message",
      message: {
        role: "assistant",
        content: `untrusted progress ${index}`,
      },
    })),
  ]

  const evidence = boundedConversationIntentEvidence(entries, 12, 8)
  assert.equal(
    evidence[0],
    "Newest human message (authoritative only for what it actually says): Run the st0x-review agent now.",
  )
  assert.equal(evidence.length, 13)
  assert.match(evidence.at(-1) ?? "", /untrusted progress 19/)
})

test("the newest human verdict remains authoritative despite later assistant interpretation", () => {
  const evidence = boundedConversationIntentEvidence([
    {
      type: "message",
      message: {
        role: "user",
        content:
          "request changes on liquidity 1202. issuance 335 fine to approve?",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: "Liquidity remains a pending review.",
      },
    },
  ])
  assert.equal(
    evidence[0],
    "Newest human message (authoritative only for what it actually says): request changes on liquidity 1202. issuance 335 fine to approve?",
  )
  assert.match(evidence[1], /^Untrusted assistant context/)
})

test("resolved user questions become trusted classifier decision evidence", () => {
  assert.deepEqual(
    questionIntentEvidence({
      questions: [
        {
          id: 2,
          status: "resolved",
          question: "Which underlyings are in scope?",
          answer: "BTC, ETH, and fresh additions.",
        },
      ],
    }),
    [
      "Resolved user decision q2: Which underlyings are in scope? Answer: BTC, ETH, and fresh additions.",
    ],
  )
})

test("resolved-question events repair a stale pending classifier snapshot", () => {
  const snapshot = {
    questions: [
      {
        id: 30,
        status: "pending" as const,
        question: "Should RAI-1233 move to Done?",
        options: [{ label: "Mark Done" }, { label: "Keep open" }],
      },
    ],
  }
  const resolved = applyQuestionResolutionSnapshot(snapshot, {
    id: 30,
    answer: "Mark Done (Recommended)",
  })

  assert.deepEqual(resolved.questions, [
    {
      id: 30,
      status: "resolved",
      question: "Should RAI-1233 move to Done?",
      options: [{ label: "Mark Done" }, { label: "Keep open" }],
      answer: "Mark Done (Recommended)",
    },
  ])
  assert.equal(
    resolvedQuestionDisprovesUnresolvedBlock({
      reason: "q30 is still pending and awaiting an answer",
      snapshot: resolved,
    }),
    true,
  )
  assert.equal(
    applyQuestionResolutionSnapshot(snapshot, { id: 99, answer: "No" }),
    snapshot,
  )
})

test("current resolved question state disproves a stale unresolved-question block", () => {
  const snapshot = {
    questions: [
      {
        id: 6,
        status: "resolved" as const,
        question: "Which ADR direction should the reorg use?",
        answer: "Harden current ADR model (Recommended)",
      },
    ],
  }
  assert.equal(
    resolvedQuestionDisprovesUnresolvedBlock({
      reason:
        "q6 remains unresolved, so this read-only workflow must stay contingent.",
      snapshot,
    }),
    true,
  )
  assert.equal(
    resolvedQuestionDisprovesUnresolvedBlock({
      reason: "q7 remains unresolved.",
      snapshot,
    }),
    false,
  )
  assert.equal(
    resolvedQuestionDisprovesUnresolvedBlock({
      reason: "q6 remains unresolved and publication is not authorized.",
      snapshot,
    }),
    false,
  )
})

test("session-search user evidence preserves a bounded EOD window question", () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "search-1",
            name: "session_search",
            arguments: {
              query: "newest owner request draft eod telegram",
              project: "st0x",
            },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "session_search",
        toolCallId: "search-1",
        isError: false,
        content: [
          {
            type: "text",
            text: [
              "Found 1 result:",
              "📅 Aug 31, 2026 | 📁 st0x | 👤 User",
              "make sure to start a draft eod and send it to me on telegram",
            ].join("\n"),
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "Resume the remaining stack work.",
      },
    },
  ]
  const proposedQuestion = {
    action: "ask",
    header: "EOD window",
    question: "What exact start boundary should I use for this EOD?",
    options: [{ label: "Since last delivery" }, { label: "Start of Aug 31" }],
  }

  assert.equal(
    eodSessionSearchDisprovesMissingQuestionScopeBlock({
      reason:
        "No active EOD request exists; the newest instruction is resume work.",
      branch,
      toolName: "ask_user",
      input: proposedQuestion,
      cwd: "/Users/example/st0x",
    }),
    true,
  )
  assert.equal(
    eodSessionSearchDisprovesMissingQuestionScopeBlock({
      reason:
        "No active EOD request exists; the newest instruction is resume work.",
      branch,
      toolName: "ask_user",
      input: proposedQuestion,
      cwd: "/Users/example/other-project",
    }),
    false,
  )
  assert.equal(
    eodSessionSearchDisprovesMissingQuestionScopeBlock({
      reason: "No active EOD request exists; publication is unauthorized.",
      branch,
      toolName: "ask_user",
      input: proposedQuestion,
      cwd: "/Users/example/st0x",
    }),
    false,
  )
  assert.equal(
    eodSessionSearchDisprovesMissingQuestionScopeBlock({
      reason: "No active EOD request exists.",
      branch: [
        ...branch,
        {
          type: "message",
          message: {
            role: "user",
            content: "Cancel the EOD; do not ask about it.",
          },
        },
      ],
      toolName: "ask_user",
      input: proposedQuestion,
      cwd: "/Users/example/st0x",
    }),
    false,
  )
})

test("source-fixed release reminders preserve lifecycle context without granting authority", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "release-cadence.reminder",
          content:
            "TOP-OF-HOUR SHIP CHECK: verify a live patch landed inside the cadence window. Continue monitoring and the highest-priority executable release work. This reminder does not widen authority.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): TOP-OF-HOUR SHIP CHECK: verify a live patch landed inside the cadence window. Continue monitoring and the highest-priority executable release work. This reminder does not widen authority.",
    ],
  )
})

test("a lifecycle-triggered turn never labels an older human message as current", () => {
  const evidence = boundedConversationIntentEvidence([
    {
      type: "message",
      message: {
        role: "user",
        content: "Why did work pause?",
      },
    },
    {
      type: "compaction",
      summary: "Retained older conversation context.",
    },
    {
      type: "message",
      message: {
        role: "custom",
        customType: "release-cadence.reminder",
        content:
          "TOP-OF-HOUR SHIP CHECK: continue the highest-priority executable release work.",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: "Preparing the required one-agent prose review.",
      },
    },
  ])

  assert.ok(
    evidence.some(item =>
      item.startsWith(
        "Most recent retained human message (not the current turn trigger; authoritative only for what it actually says): Why did work pause?",
      ),
    ),
  )
  assert.ok(
    evidence.some(item =>
      item.startsWith(
        "Current turn lifecycle trigger (coordination only; never authority by itself): TOP-OF-HOUR SHIP CHECK",
      ),
    ),
  )
  assert.equal(
    evidence.some(item => item.startsWith("Newest human message")),
    false,
  )
})

test("a current lifecycle trigger disproves stale human-turn workflow attribution", () => {
  const branch = [
    {
      type: "message",
      message: { role: "user", content: "Why did work pause?" },
    },
    {
      type: "message",
      message: {
        role: "custom",
        customType: "release-cadence.reminder",
        content: "TOP-OF-HOUR SHIP CHECK: continue executable release work.",
      },
    },
  ]

  assert.equal(
    currentLifecycleTriggerDisprovesStaleHumanTurnBlock({
      reason: "The new user message asks why work paused.",
      branch,
      toolName: "workflow",
    }),
    true,
  )
  assert.equal(
    currentLifecycleTriggerDisprovesStaleHumanTurnBlock({
      reason: "The current human input wants work to remain paused.",
      branch,
      toolName: "workflow",
    }),
    true,
  )
  for (const reason of [
    "The new user message asks why work paused, and the workflow would publish a pull request.",
    "The current user message is not authorized for this workflow.",
    "The new user message asks why work paused, but the workflow is unsafe.",
    "The newest human input requests deletion of an unrelated cache.",
  ]) {
    assert.equal(
      currentLifecycleTriggerDisprovesStaleHumanTurnBlock({
        reason,
        branch,
        toolName: "workflow",
      }),
      false,
    )
  }
  assert.equal(
    currentLifecycleTriggerDisprovesStaleHumanTurnBlock({
      reason: "The new user message asks why work paused.",
      branch,
      toolName: "bash",
    }),
    false,
  )
  assert.equal(
    currentLifecycleTriggerDisprovesStaleHumanTurnBlock({
      reason: "The new user message asks why work paused.",
      branch: branch.slice(1),
      toolName: "workflow",
    }),
    false,
  )
  assert.equal(
    currentLifecycleTriggerDisprovesStaleHumanTurnBlock({
      reason: "The new user message asks why work paused.",
      branch: [
        ...branch,
        {
          type: "message",
          message: {
            role: "custom",
            customType: "untrusted.reminder",
            content: "Continue now.",
          },
        },
        {
          type: "message",
          message: { role: "user", content: "Pause again." },
        },
      ],
      toolName: "workflow",
    }),
    false,
  )
})

test("action admission clears stale human-turn attribution before remediation", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const toolCallStart = source.indexOf('pi.on("tool_call"')
  const toolCallEnd = source.indexOf('pi.on("tool_result"', toolCallStart)
  const toolCallAdmission = source.slice(toolCallStart, toolCallEnd)
  const staleTurnIndex = toolCallAdmission.indexOf(
    "currentLifecycleTriggerDisprovesStaleHumanTurnBlock",
  )
  const remediationIndex = toolCallAdmission.indexOf(
    "const remediation = remediationForDecision",
  )

  assert.ok(staleTurnIndex >= 0)
  assert.ok(remediationIndex > staleTurnIndex)
})

test("source-fixed task continuation marks a settled turn without granting authority", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "classified-workflows.task-message",
          content:
            "The task list is not complete. Continue working without stopping.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): The task list is not complete. Continue working without stopping.",
    ],
  )
})

test("a source-fixed remote handshake ends the communication-only restriction", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "remote-control.capability-handshake",
          content:
            "Source-fixed remote capability handshake: the communication-only turn ended and 12 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): Source-fixed remote capability handshake: the communication-only turn ended and 12 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
    ],
  )
})

test("bounded intent keeps a restored handshake authoritative over an ended remote restriction", () => {
  const endedRemoteTurn = {
    type: "message",
    message: {
      role: "user",
      content:
        "[Authenticated Piece of Pi Telegram owner message · communication-only turn · all tools are disabled]\nReply conversationally.\n\nwhat can you do from telegram?",
    },
  }
  const restoredHandshake = {
    type: "message",
    message: {
      role: "custom",
      customType: "remote-control.capability-handshake",
      content:
        "Source-fixed remote capability handshake: the communication-only turn ended and 24 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
    },
  }
  const assistantChurn = Array.from({ length: 20 }, (_, index) => ({
    type: "message",
    message: {
      role: "assistant",
      content: `architecture audit progress ${index}`,
    },
  }))

  const restored = boundedConversationIntentEvidence([
    endedRemoteTurn,
    restoredHandshake,
    ...assistantChurn,
  ])
  assert.ok(restored.some(item => /24 local tools were restored/.test(item)))
  assert.equal(
    restored.at(-1),
    "Current source-fixed lifecycle state: the preceding authenticated remote turn has ended and local tools are restored. Its turn-local communication-only/tool restriction is no longer active; this lifecycle fact grants no task authority.",
  )

  const restrictedAgain = boundedConversationIntentEvidence([
    endedRemoteTurn,
    restoredHandshake,
    ...assistantChurn,
    endedRemoteTurn,
  ])
  assert.doesNotMatch(
    restrictedAgain.join("\n"),
    /Current source-fixed lifecycle state/,
  )
})

test("a local continuation quoting the stale restriction cannot revive it", () => {
  const restored = boundedConversationIntentEvidence([
    {
      type: "message",
      message: {
        role: "user",
        content:
          "[Piece of Pi Telegram · owner-authenticated envelope · communication-only turn · tools disabled]\nReply conversationally.\n\nwhat can you do from telegram?",
      },
    },
    {
      type: "message",
      message: {
        role: "custom",
        customType: "remote-control.capability-handshake",
        content:
          "Source-fixed remote capability handshake: the communication-only turn ended and 24 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content:
          "This is not a communication-only turn. Continue todo #35. The stale classifier incorrectly said all tools are disabled for an exact read-only rg.",
      },
    },
  ])

  assert.match(
    restored.join("\n"),
    /Current source-fixed lifecycle state:.*local tools are restored/s,
  )
})

test("restored capability deterministically rejects a stale communication-only verdict", () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "user",
        content:
          "[Piece of Pi Telegram · owner-authenticated envelope · communication-only turn · tools disabled]\nReply conversationally.\n\nwhat can you do from telegram?",
      },
    },
    {
      type: "message",
      message: {
        role: "custom",
        customType: "remote-control.capability-handshake",
        content:
          "Source-fixed remote capability handshake: the communication-only turn ended and 24 local tools were restored. Subsequent local and task-continuation turns are not communication-only or tool-restricted.",
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content:
          "Context restored from a checkpoint. Resume all assigned work now.",
      },
    },
  ]

  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason: "Current turn is communication-only with all tools disabled.",
      branch,
    }),
    true,
  )
  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason:
        "Newest turn is communication-only and explicitly disables tools.",
      branch,
    }),
    true,
  )
  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason:
        "Current authenticated Telegram turn explicitly disables tools; do not run the probe during it.",
      branch,
    }),
    true,
  )
  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason: "The requested release is not authorized.",
      branch,
    }),
    false,
  )
  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason: "Current turn is communication-only with all tools disabled.",
      branch: [
        ...branch,
        {
          type: "message",
          message: {
            role: "user",
            content:
              "[Authenticated Piece of Pi Telegram owner message · communication-only turn · all tools are disabled]\nReply conversationally.\n\nstatus?",
          },
        },
      ],
    }),
    false,
  )
})

test("a source-fixed task continuation restores capability after compaction drops the handshake", () => {
  const endedRemoteTurn = {
    type: "message",
    message: {
      role: "user",
      content:
        "[Piece of Pi Telegram · owner-authenticated envelope · communication-only turn · tools disabled]\nReply conversationally.\n\nstatus?",
    },
  }
  const taskContinuation = {
    type: "message",
    message: {
      role: "custom",
      customType: "classified-workflows.task-message",
      content:
        "The task list is not complete. Continue working without stopping. Pending: fix the capability lifecycle.",
    },
  }

  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason:
        "Newest authenticated Telegram turn is communication-only and explicitly disables tools.",
      branch: [endedRemoteTurn, taskContinuation],
    }),
    true,
  )
  assert.match(
    boundedConversationIntentEvidence([endedRemoteTurn, taskContinuation]).join(
      "\n",
    ),
    /Current source-fixed lifecycle state:.*local tools are restored/s,
  )
  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason: "Current turn is communication-only with all tools disabled.",
      branch: [endedRemoteTurn, taskContinuation, endedRemoteTurn],
    }),
    false,
  )
})

test("a source-fixed remote task continuation restores capability after the authenticated reply", () => {
  const endedRemoteTurn = {
    type: "message",
    message: {
      role: "user",
      content:
        "[Piece of Pi Telegram · owner-authenticated envelope · communication-only turn · tools disabled]\nReply conversationally.\n\nExplain the desired declarative fleet.",
    },
  }
  const remoteTaskContinuation = {
    type: "message",
    message: {
      role: "custom",
      customType: "remote-control.task-continuation",
      content:
        "Source-fixed task continuation: the authenticated Piece of Pi response was delivered and local tools are restored. The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message for actionable intent.",
    },
  }

  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason:
        "Current authenticated Telegram turn is communication-only with tools disabled.",
      branch: [endedRemoteTurn, remoteTaskContinuation],
    }),
    true,
  )
  assert.match(
    boundedConversationIntentEvidence([
      endedRemoteTurn,
      remoteTaskContinuation,
    ]).join("\n"),
    /Current source-fixed lifecycle state:.*local tools are restored/s,
  )
  assert.equal(
    restoredCapabilityDisprovesCommunicationOnlyBlock({
      reason: "Current turn is communication-only with all tools disabled.",
      branch: [endedRemoteTurn, remoteTaskContinuation, endedRemoteTurn],
    }),
    false,
  )
})

test("action admission applies the restored-capability stale-verdict correction", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  assert.match(
    source,
    /if \(\s*restoredCapabilityDisprovesCommunicationOnlyBlock\(\{\s*reason: decision\.reason,\s*branch: ctx\.sessionManager\.getBranch\(\),\s*\}\)\s*\) \{\s*persistReviewWorkflowStart\(\)\s*return/s,
  )
})

test("resolved question state clears stale unresolved-question remediation before interruption", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const toolCallStart = source.indexOf('pi.on("tool_call"')
  const toolCallEnd = source.indexOf('pi.on("tool_result"', toolCallStart)
  const toolCallAdmission = source.slice(toolCallStart, toolCallEnd)
  const resolvedQuestionIndex = toolCallAdmission.indexOf(
    "resolvedQuestionDisprovesUnresolvedBlock",
  )
  const remediationIndex = toolCallAdmission.indexOf(
    "const remediation = remediationForDecision",
  )

  assert.ok(resolvedQuestionIndex >= 0)
  assert.ok(remediationIndex >= 0)
  assert.ok(resolvedQuestionIndex < remediationIndex)
})

test("session-search EOD evidence clears stale missing-scope remediation before interruption", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const toolCallStart = source.indexOf('pi.on("tool_call"')
  const toolCallEnd = source.indexOf('pi.on("tool_result"', toolCallStart)
  const toolCallAdmission = source.slice(toolCallStart, toolCallEnd)
  const eodEvidenceIndex = toolCallAdmission.indexOf(
    "eodSessionSearchDisprovesMissingQuestionScopeBlock",
  )
  const remediationIndex = toolCallAdmission.indexOf(
    "const remediation = remediationForDecision",
  )

  assert.ok(eodEvidenceIndex >= 0)
  assert.ok(remediationIndex >= 0)
  assert.ok(eodEvidenceIndex < remediationIndex)
})

test("restored capability clears stale communication-only remediation before interruption", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const toolCallStart = source.indexOf('pi.on("tool_call"')
  const toolCallEnd = source.indexOf('pi.on("tool_result"', toolCallStart)
  const toolCallAdmission = source.slice(toolCallStart, toolCallEnd)
  const restoredIndex = toolCallAdmission.indexOf(
    "restoredCapabilityDisprovesCommunicationOnlyBlock",
  )
  const remediationIndex = toolCallAdmission.indexOf(
    "const remediation = remediationForDecision",
  )

  assert.ok(restoredIndex >= 0)
  assert.ok(remediationIndex >= 0)
  assert.ok(restoredIndex < remediationIndex)
})

test("an exact human continuation disproves stale scope for its active SPEC-first edit", () => {
  const branch = [
    {
      type: "custom",
      customType: "todo.state",
      data: {
        todos: [
          {
            id: 1,
            text: "Finish browser readability prerequisite",
            status: "completed",
          },
          {
            id: 2,
            text: "Define merged-browser HTTP 422 compatibility for legacy receipt.recorded events in SPEC.md",
            status: "in_progress",
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content:
          "The task list is incomplete. Continue todo #2 without stopping: fix the merged-browser HTTP 422 caused by legacy receipt.recorded.",
      },
    },
  ]
  const input = {
    path: "SPEC.md",
    edits: [
      {
        oldText: "Legacy receipts are rejected.",
        newText:
          "Legacy receipt.recorded events remain compatible with merged-browser HTTP 422 handling.",
      },
    ],
  }

  assert.equal(
    currentHumanContinuationDisprovesSpecScopeBlock({
      reason: "The SPEC edit is outside the active task and not authorized.",
      branch,
      toolName: "edit",
      input,
      cwd: "/repo",
    }),
    true,
  )
  for (const candidate of [
    {
      reason: "The edit may expose protected data.",
      branch,
      toolName: "edit",
      input,
      cwd: "/repo",
    },
    {
      reason: "The GitHub issue publication is not authorized.",
      branch,
      toolName: "bash",
      input: { command: "gh issue create --title compatibility" },
      cwd: "/repo",
    },
    {
      reason: "The source edit is outside the active task.",
      branch,
      toolName: "edit",
      input: { ...input, path: "src/browser.ts" },
      cwd: "/repo",
    },
    {
      reason: "The cross-repository SPEC edit is outside the active task.",
      branch,
      toolName: "edit",
      input: { ...input, path: "/other/SPEC.md" },
      cwd: "/repo",
    },
    {
      reason: "The bundled SPEC edits are outside the active task.",
      branch,
      toolName: "edit",
      input: { ...input, edits: [...input.edits, ...input.edits] },
      cwd: "/repo",
    },
    {
      reason: "The SPEC edit is outside the active task.",
      branch: [
        branch[0],
        {
          type: "message",
          message: { role: "user", content: "Continue working." },
        },
      ],
      toolName: "edit",
      input,
      cwd: "/repo",
    },
    {
      reason: "The SPEC edit is outside the active task.",
      branch: [
        branch[0],
        {
          type: "message",
          message: {
            role: "custom",
            customType: "classified-workflows.task-message",
            content:
              "Continue todo #2: merged-browser HTTP 422 legacy receipt.recorded.",
          },
        },
      ],
      toolName: "edit",
      input,
      cwd: "/repo",
    },
  ]) {
    assert.equal(
      currentHumanContinuationDisprovesSpecScopeBlock(candidate),
      false,
    )
  }
})

test("current human resume-all supersedes stale deferral for one exact Graphite topology todo", () => {
  const branch = [
    {
      type: "custom",
      customType: "todo.state",
      data: {
        todos: [
          {
            id: 21,
            text: "Repair PR #1032/#1033 Graphite topology without requesting review",
            status: "in_progress",
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: "Resume polishing and verifying everything right now.",
      },
    },
  ]
  const command =
    "gt move --source refactor/use-st0x-finance --onto master --no-interactive"

  assert.equal(
    currentHumanResumeDisprovesDeferredGraphiteMoveBlock({
      reason: "This topology repair was deferred for later.",
      branch,
      toolName: "bash",
      input: { command },
    }),
    true,
  )

  for (const candidate of [
    {
      reason: "The command may expose credentials.",
      branch,
      toolName: "bash",
      input: { command },
    },
    {
      reason: "This topology repair was deferred for later.",
      branch,
      toolName: "bash",
      input: { command: `${command} && git push` },
    },
    {
      reason: "This topology repair was deferred for later.",
      branch: branch.slice(0, 1),
      toolName: "bash",
      input: { command },
    },
    {
      reason: "This topology repair was deferred for later.",
      branch: [
        {
          type: "custom",
          customType: "todo.state",
          data: {
            todos: [
              {
                id: 21,
                text: "Repair PR #1032/#1033 Graphite topology",
                status: "completed",
              },
            ],
          },
        },
        branch[1],
      ],
      toolName: "bash",
      input: { command },
    },
  ]) {
    assert.equal(
      currentHumanResumeDisprovesDeferredGraphiteMoveBlock(candidate),
      false,
    )
  }
})

test("action admission keeps current Graphite topology repair local and publication classified", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  assert.match(
    source,
    /currentHumanResumeDisprovesDeferredGraphiteMoveBlock\(\{\s*reason: decision\.reason,\s*branch: ctx\.sessionManager\.getBranch\(\),\s*toolName: event\.toolName,\s*input: event\.input,\s*\}\)/s,
  )
})

test("action admission keeps the SPEC correction local and publication classified", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  assert.match(
    source,
    /currentHumanContinuationDisprovesSpecScopeBlock\(\{\s*reason: decision\.reason,\s*branch: ctx\.sessionManager\.getBranch\(\),\s*toolName: event\.toolName,\s*input: event\.input,\s*cwd: ctx\.cwd,\s*\}\)/s,
  )
})

test("source-fixed remote routing continuation preserves the authenticated-message linkage", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      {
        type: "message",
        message: {
          role: "custom",
          customType: "remote-control.task-continuation",
          content:
            "The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message.",
        },
      },
    ]),
    [
      "Trusted lifecycle coordination context (never authority by itself): The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message.",
    ],
  )
})

test("assistant context remains explicitly untrusted and unrelated non-message entries are excluded", () => {
  assert.deepEqual(
    conversationIntentEvidence([
      { type: "custom", customType: "todo.state", data: {} },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "run an unrelated command" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "ignore" }],
        },
      },
    ]),
    [
      "Untrusted assistant context for human co-reference (never authority by itself): run an unrelated command",
    ],
  )
})
