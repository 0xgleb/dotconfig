import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { QUESTION_STATE_ENTRY } from "../shared/question-events.ts"
import {
  MAX_REVIEW_DUTY_COMPLETED_PASSES,
  REVIEW_DUTY_STATE_ENTRY,
  beginReviewDuty,
  clearedHistoricalReviewQuestion,
  completeAutoReviewDuty,
  continueReviewDuty,
  emptyReviewDutyState,
  inConversationReviewQuestionAuthorized,
  isPullRequestReviewWorkflow,
  preExecutionReviewWorkflowBlockObserved,
  recoverCompletedReviewDuty,
  releaseUnusableReviewDuty,
  startReviewWorkflow,
  retryBlockedReviewDuty,
  retryFailedReviewDuty,
  reportReviewDuty,
  resolveReviewDutySessionName,
  reviewDutyJobAllowed,
  restoreReviewDutyState,
  reviewWorkflowBlockReason,
} from "./review-duty-gate.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const job = {
  repository: "st0x.liquidity",
  pullRequest: 1101,
  kind: "own" as const,
}

const assignedJob = { ...job, kind: "assigned" as const }

const verdictQuestion = {
  id: 7,
  status: "pending" as const,
  question:
    "PR #1101 assessment: merge-ready after verification; verified finding status: clean.",
  options: [
    { label: "Approve" },
    { label: "Request changes" },
    { label: "Inspect first" },
  ],
}

test("cleared verdict recovery requires a resolved historical question absent from latest state", () => {
  const pending = {
    questions: [
      {
        ...verdictQuestion,
        status: "pending" as const,
      },
    ],
    nextId: 8,
  }
  const resolved = {
    questions: [
      {
        ...verdictQuestion,
        status: "resolved" as const,
        answer: "Inspect first",
      },
    ],
    nextId: 8,
  }
  const cleared = { questions: [], nextId: 8 }
  const entry = (data: unknown) => ({
    type: "custom",
    customType: "pi.questions.state",
    data,
  })

  assert.deepEqual(
    clearedHistoricalReviewQuestion(
      [entry(pending), entry(resolved), entry(cleared)],
      7,
    ),
    { ...verdictQuestion, status: "resolved" },
  )
  assert.equal(
    clearedHistoricalReviewQuestion([entry(pending), entry(resolved)], 7),
    undefined,
  )
})

test("review recovery requires both cleared question history and durable relay history", () => {
  assert.match(extensionSource, /Type\.Literal\("recover"\)/)
  assert.match(
    extensionSource,
    /request\.action === "recover"[\s\S]*?clearedHistoricalReviewQuestion[\s\S]*?isQuestionHistoricallyRelayed/,
  )
  assert.match(
    extensionSource,
    /Recovered linked user-cleared verdict question/,
  )
})

test("blocked review workflow classification cannot consume the active gate", () => {
  const handler = extensionSource.slice(
    extensionSource.indexOf('pi.on("tool_call"'),
    extensionSource.indexOf('pi.on("tool_result"'),
  )
  assert.ok(
    handler.indexOf("classifyWithActivity") <
      handler.lastIndexOf("persistReviewWorkflowStart()"),
  )
  assert.match(
    handler,
    /current typed review-duty state: \$\{JSON\.stringify\(reviewDutyState\)\}/,
  )
  assert.match(
    handler,
    /terminalWorkflowFailureDisprovesOwnershipBlock[\s\S]*?persistReviewWorkflowStart\(\)/,
  )
})

test("pre-execution workflow recovery cannot bypass an observed review workflow", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  const awaiting = startReviewWorkflow(active.state, 20)

  const stateEntry = {
    type: "custom",
    customType: REVIEW_DUTY_STATE_ENTRY,
    data: awaiting,
  }
  const classifierBlock = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "workflow",
      isError: true,
      content: [
        {
          type: "text",
          text: "Auto-classifier verdict: current begin evidence was missed",
        },
      ],
    },
  }
  assert.equal(
    preExecutionReviewWorkflowBlockObserved(
      [stateEntry, classifierBlock],
      awaiting,
    ),
    true,
  )
  assert.equal(
    preExecutionReviewWorkflowBlockObserved(
      [
        stateEntry,
        classifierBlock,
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "workflow",
            isError: false,
            content: "workflow completed",
          },
        },
      ],
      awaiting,
    ),
    false,
  )

  const recovered = retryBlockedReviewDuty(awaiting, false, true)
  assert.deepEqual(recovered, { ok: true, state: active.state })
  assert.match(
    retryBlockedReviewDuty(awaiting, true, true).error ?? "",
    /execution evidence exists/i,
  )
  assert.match(
    retryBlockedReviewDuty(awaiting, false, false).error ?? "",
    /no matching pre-execution/i,
  )
  assert.match(
    retryBlockedReviewDuty(active.state, false, true).error ?? "",
    /no pre-execution/i,
  )

  assert.match(extensionSource, /Type\.Literal\("retry-blocked"\)/)
  assert.match(
    extensionSource,
    /request\.action === "retry-blocked"[\s\S]*?workflowAudits\.workflows\.some[\s\S]*?backgroundWorkflows\.values\(\)[\s\S]*?retryBlockedReviewDuty/,
  )
})

test("completed review passes may continue only the same job within a bounded loop", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  const awaiting = startReviewWorkflow(active.state, 20)

  const continued = continueReviewDuty(awaiting, true, false, 1)
  assert.deepEqual(continued, {
    ok: true,
    state: { ...active.state, continuation: "fix-re-review" },
  })
  assert.equal(continued.ok, true)
  if (continued.ok) {
    assert.match(
      beginReviewDuty(continued.state, { ...job, pullRequest: 1102 }, 30)
        .error ?? "",
      /already the active review-duty job/i,
    )
  }
  assert.match(
    continueReviewDuty(awaiting, false, false, 1).error ?? "",
    /not proven completed/i,
  )
  assert.match(
    continueReviewDuty(awaiting, true, true, 1).error ?? "",
    /still running/i,
  )
  assert.match(
    continueReviewDuty(awaiting, true, false, MAX_REVIEW_DUTY_COMPLETED_PASSES)
      .error ?? "",
    /bounded 6-pass limit/i,
  )
  assert.match(extensionSource, /Type\.Literal\("continue"\)/)
  const continueHandler = extensionSource.slice(
    extensionSource.indexOf('request.action === "continue"'),
    extensionSource.indexOf('request.action === "retry-failed"'),
  )
  assert.match(continueHandler, /latestCompletedWorkflowAfter/)
  assert.match(continueHandler, /completedPasses/)
  assert.match(continueHandler, /continueReviewDuty/)
})

test("failed workflow recovery resumes only the same gated job", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  const awaiting = startReviewWorkflow(active.state, 20)

  const recovered = retryFailedReviewDuty(awaiting, true, false)
  assert.deepEqual(recovered, {
    ok: true,
    state: active.state,
  })
  assert.equal(recovered.ok, true)
  if (recovered.ok) {
    assert.match(
      beginReviewDuty(recovered.state, { ...job, pullRequest: 1102 }, 30)
        .error ?? "",
      /already the active review-duty job/i,
    )
  }
  assert.match(
    retryFailedReviewDuty(awaiting, false, false).error ?? "",
    /not a proven terminal failure/i,
  )
  assert.match(
    retryFailedReviewDuty(awaiting, true, true).error ?? "",
    /still running/i,
  )
  assert.match(
    retryFailedReviewDuty(active.state, true, false).error ?? "",
    /no failed review-duty workflow/i,
  )
  assert.match(extensionSource, /Type\.Literal\("retry-failed"\)/)
  const retryHandler = extensionSource.slice(
    extensionSource.indexOf('request.action === "retry-failed"'),
    extensionSource.indexOf("if (request.questionId === undefined)"),
  )
  assert.match(retryHandler, /latestFailedWorkflowAfter/)
  assert.match(retryHandler, /partialChildren/)
  assert.match(retryHandler, /retryFailedReviewDuty/)
})

test("usable completed evidence restores the matching completion gate without discarding the old review", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return

  assert.deepEqual(recoverCompletedReviewDuty(active.state, 20, true, false), {
    ok: true,
    state: { ...active.state, phase: "awaiting_report", completedAt: 20 },
  })
  assert.match(
    recoverCompletedReviewDuty(active.state, 20, false, false).error ?? "",
    /no usable completed review evidence/i,
  )
  assert.match(
    recoverCompletedReviewDuty(active.state, 20, true, true).error ?? "",
    /still running/i,
  )
  assert.match(
    recoverCompletedReviewDuty(
      startReviewWorkflow(active.state, 20),
      20,
      true,
      false,
    ).error ?? "",
    /no active review-duty job/i,
  )
  assert.match(
    recoverCompletedReviewDuty(active.state, 9, true, false).error ?? "",
    /predates the active review-duty job/i,
  )

  assert.match(extensionSource, /Type\.Literal\("recover-evidence"\)/)
  assert.match(
    extensionSource,
    /request\.action === "recover-evidence"[\s\S]*?child\.status === "completed"[\s\S]*?child\.outputCharacters > 0[\s\S]*?recoverCompletedReviewDuty/,
  )
  assert.match(
    extensionSource,
    /preserved its usable output; create or reuse the exact verdict question/,
  )
})

test("an unusable or wrongly begun review job can be released without inventing a verdict", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  const awaiting = startReviewWorkflow(active.state, 20)

  assert.deepEqual(releaseUnusableReviewDuty(active.state, false, false), {
    ok: true,
    state: emptyReviewDutyState,
  })
  assert.deepEqual(releaseUnusableReviewDuty(awaiting, false, false), {
    ok: true,
    state: emptyReviewDutyState,
  })
  assert.match(
    releaseUnusableReviewDuty(awaiting, true, false).error ?? "",
    /complete-auto after a clean own-review pass.*remains required/i,
  )
  assert.match(
    releaseUnusableReviewDuty(awaiting, false, true).error ?? "",
    /still running/i,
  )
  assert.match(
    releaseUnusableReviewDuty(emptyReviewDutyState, false, false).error ?? "",
    /no active review-duty job/i,
  )

  const releaseHandler = extensionSource.slice(
    extensionSource.indexOf('request.action === "release-unusable"'),
    extensionSource.indexOf("if (request.questionId === undefined)"),
  )
  assert.match(releaseHandler, /workflow\.status === "completed"/)
  assert.match(releaseHandler, /child\.status === "completed"/)
  assert.match(releaseHandler, /child\.outputCharacters > 0/)
  assert.match(
    releaseHandler,
    /grants no review, mutation, or publication authority/,
  )
})

test("managed reload cancellation recovers only an auto same-PR fix continuation", () => {
  const automatic = beginReviewDuty(
    emptyReviewDutyState,
    { repository: "0xgleb/dotconfig", pullRequest: 42, kind: "auto" },
    10,
  )
  assert.equal(automatic.ok, true)
  if (!automatic.ok) return
  const continued = {
    ...automatic.state,
    continuation: "fix-re-review" as const,
  }
  const awaiting = startReviewWorkflow(continued, 20)
  assert.deepEqual(retryFailedReviewDuty(awaiting, false, false, true), {
    ok: true,
    state: continued,
  })
  const legacyAwaitingWithoutMarker = startReviewWorkflow(automatic.state, 20)
  assert.match(
    retryFailedReviewDuty(
      legacyAwaitingWithoutMarker,
      false,
      false,
      true,
      false,
    ).error ?? "",
    /not a proven terminal failure/i,
  )
  assert.deepEqual(
    retryFailedReviewDuty(
      legacyAwaitingWithoutMarker,
      false,
      false,
      true,
      true,
    ),
    {
      ok: true,
      state: {
        ...automatic.state,
        continuation: "fix-re-review",
      },
    },
  )
  assert.match(
    retryFailedReviewDuty(
      startReviewWorkflow(
        {
          phase: "active",
          ...job,
          startedAt: 10,
          continuation: "fix-re-review",
        },
        20,
      ),
      false,
      false,
      true,
      true,
    ).error ?? "",
    /not a proven terminal failure/i,
  )
  assert.match(extensionSource, /latestManagedReloadCancellationAfter/)
  assert.match(extensionSource, /latestLegacyUnmarkedCancellationAfter/)
  assert.match(extensionSource, /managedReloadCompletionObservedAfterAudit/)
  assert.match(extensionSource, /auto-reload\.completed/)
  assert.match(extensionSource, /const manualPause = latestContinuationPause/)
  assert.match(extensionSource, /!manualPause/)
  assert.match(extensionSource, /MANAGED_RELOAD_WORKFLOW_CANCELLATION/)
  assert.match(extensionSource, /recovery evidence: \$\{recoveryEvidence\}/)
})

test("review reporting waits boundedly for asynchronous Telegram linkage", () => {
  assert.match(extensionSource, /const REVIEW_DUTY_RELAY_ATTEMPTS = 12/)
  assert.match(
    extensionSource,
    /const awaitQuestionRelay[\s\S]*?isQuestionRelayed[\s\S]*?Effect\.sleep\("1 second"\)/,
  )
  assert.match(
    extensionSource,
    /awaitQuestionRelay\([\s\S]*?ctx\.sessionManager\.getSessionId\(\)[\s\S]*?request\.questionId/,
  )
})

test("managed reviewer roots resolve to source-fixed dedicated review-duty identities", () => {
  const home = "/Users/reviewer"
  assert.equal(
    resolveReviewDutySessionName("dataclique", `${home}/code/dataclique`, home),
    "dataclique-review-duty",
  )
  assert.equal(
    resolveReviewDutySessionName("0xgleb", `${home}/code/0xgleb`, home),
    "personal-review-duty",
  )
  assert.equal(
    resolveReviewDutySessionName("st0x", `${home}/code/st0x`, home),
    "st0x-review-duty",
  )
  assert.equal(
    resolveReviewDutySessionName(
      "dataclique-review-duty",
      `${home}/elsewhere`,
      home,
    ),
    "dataclique-review-duty",
  )
  assert.equal(
    resolveReviewDutySessionName(
      "Dataclique · Reviewer",
      `${home}/code/dataclique/event-sorcery`,
      home,
    ),
    undefined,
  )
  assert.match(
    extensionSource,
    /resolveReviewDutySessionName\(pi\.getSessionName\(\), ctx\.cwd, homedir\(\)\)/,
  )
})

test("review-duty scopes jobs to each owner and exact auto-merge repository", () => {
  assert.equal(
    reviewDutyJobAllowed("dataclique-review-duty", {
      repository: "dataclique/yielduck",
      pullRequest: 42,
      kind: "auto",
    }),
    true,
  )
  assert.equal(
    reviewDutyJobAllowed("dataclique-review-duty", {
      repository: "dataclique/other",
      pullRequest: 42,
      kind: "auto",
    }),
    false,
  )
  assert.equal(
    reviewDutyJobAllowed("dataclique-review-duty", {
      repository: "0xgleb/dotconfig",
      pullRequest: 42,
      kind: "own",
    }),
    false,
  )
  assert.equal(
    reviewDutyJobAllowed("personal-review-duty", {
      repository: "0xgleb/dotconfig",
      pullRequest: 42,
      kind: "auto",
    }),
    true,
  )
  assert.equal(
    reviewDutyJobAllowed("personal-review-duty", {
      repository: "0xgleb/other",
      pullRequest: 42,
      kind: "auto",
    }),
    false,
  )
})

test("automatic and own review loops complete without an owner verdict only after a successful workflow", () => {
  const active = beginReviewDuty(
    emptyReviewDutyState,
    {
      repository: "dataclique/yielduck",
      pullRequest: 42,
      kind: "auto",
    },
    10,
  )
  assert.equal(active.ok, true)
  if (!active.ok) return
  const awaiting = startReviewWorkflow(active.state, 20)
  assert.equal(completeAutoReviewDuty(awaiting, false, false, true).ok, false)
  assert.equal(completeAutoReviewDuty(awaiting, true, true, true).ok, false)
  assert.equal(completeAutoReviewDuty(awaiting, true, false, false).ok, false)
  assert.deepEqual(completeAutoReviewDuty(awaiting, true, false, true), {
    ok: true,
    state: { phase: "idle" },
  })

  const ownActive = beginReviewDuty(emptyReviewDutyState, job, 30)
  assert.equal(ownActive.ok, true)
  if (!ownActive.ok) return
  const ownAwaiting = startReviewWorkflow(ownActive.state, 40)
  assert.equal(
    completeAutoReviewDuty(ownAwaiting, false, false, true).ok,
    false,
  )
  assert.equal(completeAutoReviewDuty(ownAwaiting, true, true, true).ok, false)
  assert.deepEqual(completeAutoReviewDuty(ownAwaiting, true, false, true), {
    ok: true,
    state: { phase: "idle" },
  })

  const assignedActive = beginReviewDuty(emptyReviewDutyState, assignedJob, 50)
  assert.equal(assignedActive.ok, true)
  if (!assignedActive.ok) return
  assert.match(
    completeAutoReviewDuty(
      startReviewWorkflow(assignedActive.state, 60),
      true,
      false,
      true,
    ).error ?? "",
    /no automatic or own review-duty job/i,
  )
})

test("complete-auto handler verifies typed scope and terminal workflow evidence", () => {
  assert.match(
    extensionSource,
    /request\.action === "complete-auto"[\s\S]*?latestCompletedWorkflowAfter[\s\S]*?reviewDutyJobAllowed[\s\S]*?completeAutoReviewDuty/,
  )
  assert.match(
    extensionSource,
    /For kind own, never create or request an Approve\/Request changes verdict/,
  )
  assert.match(
    extensionSource,
    /failed workflow call retry-failed[\s\S]*?actionable findings call continue[\s\S]*?completed clean workflow call complete-auto/,
  )
})

test("dedicated review gates apply only to actual PR review workflows", () => {
  const reviewWorkflow = {
    label: "Review PR #1101",
    code: 'return agent("Review the pull request diff and verify findings")',
  }
  const inventoryWorkflow = {
    label: "Inventory DataClique deps",
    code: 'return agent("This is not a PR review; read manifests and list dependency versions")',
  }
  assert.equal(isPullRequestReviewWorkflow(reviewWorkflow), true)
  assert.equal(isPullRequestReviewWorkflow(inventoryWorkflow), false)

  for (const sessionName of [
    "st0x-review-duty",
    "dataclique-review-duty",
    "personal-review-duty",
  ]) {
    assert.match(
      reviewWorkflowBlockReason(
        sessionName,
        emptyReviewDutyState,
        reviewWorkflow,
      ) ?? "",
      /review_duty begin/i,
    )
    assert.equal(
      reviewWorkflowBlockReason(
        sessionName,
        emptyReviewDutyState,
        inventoryWorkflow,
      ),
      undefined,
    )
  }
  assert.equal(
    reviewWorkflowBlockReason(
      "ordinary-session",
      emptyReviewDutyState,
      reviewWorkflow,
    ),
    undefined,
  )
  assert.match(extensionSource, /isPullRequestReviewWorkflow\(event\.input\)/)
})

test("every dedicated reviewer must begin a typed job before workflow execution", () => {
  const reviewWorkflow = {
    label: "Review PR #1101",
    code: 'return agent("Review the pull request diff")',
  }
  for (const sessionName of [
    "st0x-review-duty",
    "dataclique-review-duty",
    "personal-review-duty",
  ]) {
    assert.match(
      reviewWorkflowBlockReason(
        sessionName,
        emptyReviewDutyState,
        reviewWorkflow,
      ) ?? "",
      /review_duty begin/i,
    )
  }
  assert.equal(
    reviewWorkflowBlockReason(
      "ordinary-session",
      emptyReviewDutyState,
      reviewWorkflow,
    ),
    undefined,
  )
  assert.match(extensionSource, /dataclique-review-duty/)
  assert.match(extensionSource, /personal-review-duty/)
})

test("a completed assigned review workflow must link a verdict question before another job", () => {
  const active = beginReviewDuty(emptyReviewDutyState, assignedJob, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  const reviewWorkflow = {
    label: "Review PR #1101",
    code: 'return agent("Review the pull request diff")',
  }
  assert.equal(
    reviewWorkflowBlockReason("st0x-review-duty", active.state, reviewWorkflow),
    undefined,
  )

  const awaiting = startReviewWorkflow(active.state, 20)
  assert.equal(awaiting.phase, "awaiting_report")
  assert.match(
    reviewWorkflowBlockReason("st0x-review-duty", awaiting, reviewWorkflow) ??
      "",
    /persisted verdict question with an owner-authorized delivery channel/i,
  )
  const next = beginReviewDuty(
    awaiting,
    { ...assignedJob, pullRequest: 1102 },
    30,
  )
  assert.deepEqual(next, {
    ok: false,
    error:
      "PR #1101 still requires a persisted verdict question with an owner-authorized delivery channel",
  })
})

test("only assigned review reporting accepts an exact linked verdict question", () => {
  const ownActive = beginReviewDuty(emptyReviewDutyState, job, 1)
  assert.equal(ownActive.ok, true)
  if (!ownActive.ok) return
  assert.match(
    reportReviewDuty(
      startReviewWorkflow(ownActive.state, 2),
      verdictQuestion,
      true,
      3,
    ).error ?? "",
    /own review-duty jobs complete without a user verdict/i,
  )

  const active = beginReviewDuty(emptyReviewDutyState, assignedJob, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  const awaiting = startReviewWorkflow(active.state, 20)

  assert.match(
    reportReviewDuty(awaiting, verdictQuestion, false, 30).error ?? "",
    /not linked/i,
  )
  assert.match(
    reportReviewDuty(
      awaiting,
      { ...verdictQuestion, options: [{ label: "Approve" }] },
      true,
      30,
    ).error ?? "",
    /three verdict options/i,
  )
  assert.match(
    reportReviewDuty(
      awaiting,
      { ...verdictQuestion, question: "PR #999 is clean" },
      true,
      30,
    ).error ?? "",
    /PR #1101/i,
  )

  const reported = reportReviewDuty(awaiting, verdictQuestion, true, 30)
  assert.equal(reported.ok, true)
  if (!reported.ok) return
  assert.deepEqual(reported.state, {
    phase: "idle",
    lastReported: {
      ...assignedJob,
      questionId: 7,
      reportedAt: 30,
    },
  })
})

test("an explicit current-job owner instruction can link an assigned verdict question in conversation", () => {
  const active = beginReviewDuty(emptyReviewDutyState, assignedJob, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  const awaiting = startReviewWorkflow(active.state, 20)
  const gateEntry = {
    type: "custom",
    customType: REVIEW_DUTY_STATE_ENTRY,
    data: awaiting,
  }
  const questionEntry = {
    type: "custom",
    customType: QUESTION_STATE_ENTRY,
    data: { questions: [verdictQuestion], nextId: verdictQuestion.id + 1 },
  }
  const ownerInstruction = {
    type: "message",
    message: { role: "user", content: "just ask here now" },
  }

  assert.equal(
    inConversationReviewQuestionAuthorized(
      [gateEntry, ownerInstruction, questionEntry],
      awaiting,
      verdictQuestion,
    ),
    true,
  )
  const ownActive = beginReviewDuty(emptyReviewDutyState, job, 30)
  assert.equal(ownActive.ok, true)
  if (!ownActive.ok) return
  const ownAwaiting = startReviewWorkflow(ownActive.state, 40)
  assert.equal(
    inConversationReviewQuestionAuthorized(
      [
        {
          type: "custom",
          customType: REVIEW_DUTY_STATE_ENTRY,
          data: ownAwaiting,
        },
        ownerInstruction,
        questionEntry,
      ],
      ownAwaiting,
      verdictQuestion,
    ),
    false,
  )
  assert.equal(
    inConversationReviewQuestionAuthorized(
      [gateEntry, questionEntry, ownerInstruction],
      awaiting,
      verdictQuestion,
    ),
    true,
  )
  assert.equal(
    inConversationReviewQuestionAuthorized(
      [
        gateEntry,
        {
          type: "message",
          message: { role: "assistant", content: "just ask here now" },
        },
        questionEntry,
      ],
      awaiting,
      verdictQuestion,
    ),
    false,
  )
  assert.equal(
    inConversationReviewQuestionAuthorized(
      [ownerInstruction, gateEntry, questionEntry],
      awaiting,
      verdictQuestion,
    ),
    true,
  )
  assert.equal(
    inConversationReviewQuestionAuthorized(
      [
        ownerInstruction,
        {
          type: "message",
          message: { role: "user", content: "send the verdict on Telegram" },
        },
        gateEntry,
        questionEntry,
      ],
      awaiting,
      verdictQuestion,
    ),
    false,
  )
  assert.equal(
    inConversationReviewQuestionAuthorized(
      [gateEntry, ownerInstruction, questionEntry],
      awaiting,
      { ...verdictQuestion, id: verdictQuestion.id + 1 },
    ),
    false,
  )
  assert.match(
    extensionSource,
    /inConversationReviewQuestionAuthorized\([\s\S]*?ctx\.sessionManager\.getBranch\(\)[\s\S]*?reviewDutyState[\s\S]*?question/,
  )
  assert.match(
    extensionSource,
    /inConversationAuthorized \|\| relayStatus\.right/,
  )
})

test("in-conversation verdict delivery is persisted before the next-PR gate is released", () => {
  assert.match(
    extensionSource,
    /awaitConversationQuestionDelivery[\s\S]*?markQuestionDeliveredInConversation[\s\S]*?error\.code === "not_found"[\s\S]*?Effect\.sleep/,
  )
  assert.match(
    extensionSource,
    /inConversationAuthorized[\s\S]*?awaitConversationQuestionDelivery[\s\S]*?reviewDutyState = transition\.state/,
  )
  assert.doesNotMatch(extensionSource, /remoteBridge\.syncQuestions/)
  assert.match(
    extensionSource,
    /Could not persist in-conversation verdict-question delivery/,
  )
})

test("review duty state survives reload defensively", () => {
  const active = beginReviewDuty(emptyReviewDutyState, job, 10)
  assert.equal(active.ok, true)
  if (!active.ok) return
  assert.deepEqual(
    restoreReviewDutyState([
      {
        type: "custom",
        customType: REVIEW_DUTY_STATE_ENTRY,
        data: active.state,
      },
    ]),
    active.state,
  )
  const continued = {
    ...active.state,
    continuation: "fix-re-review" as const,
  }
  assert.deepEqual(
    restoreReviewDutyState([
      {
        type: "custom",
        customType: REVIEW_DUTY_STATE_ENTRY,
        data: active.state,
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "review_duty",
          details: { outcome: "continued", state: active.state },
        },
      },
    ]),
    continued,
  )
  const legacyAwaiting = startReviewWorkflow(active.state, 20)
  assert.deepEqual(
    restoreReviewDutyState([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "review_duty",
          details: { outcome: "continued", state: active.state },
        },
      },
      {
        type: "custom",
        customType: REVIEW_DUTY_STATE_ENTRY,
        data: legacyAwaiting,
      },
    ]),
    { ...legacyAwaiting, continuation: "fix-re-review" },
  )
  assert.deepEqual(
    restoreReviewDutyState([
      {
        type: "custom",
        customType: REVIEW_DUTY_STATE_ENTRY,
        data: continued,
      },
    ]),
    continued,
  )
  const automatic = beginReviewDuty(
    emptyReviewDutyState,
    { repository: "0xgleb/dotconfig", pullRequest: 42, kind: "auto" },
    30,
  )
  assert.equal(automatic.ok, true)
  if (!automatic.ok) return
  const recoveredLegacyAutoEntries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "review_duty",
        content:
          "Recovered managed-reload-cancelled workflow wf-10 for 0xgleb/dotconfig#42",
        details: { outcome: "retry-failed", state: automatic.state },
      },
    },
    {
      type: "custom",
      customType: REVIEW_DUTY_STATE_ENTRY,
      data: automatic.state,
    },
  ]
  assert.deepEqual(restoreReviewDutyState(recoveredLegacyAutoEntries), {
    ...automatic.state,
    continuation: "fix-re-review",
  })
  assert.deepEqual(
    restoreReviewDutyState([
      {
        ...recoveredLegacyAutoEntries[0],
        message: {
          ...recoveredLegacyAutoEntries[0].message,
          content: "Recovered failed workflow wf-10",
        },
      },
      recoveredLegacyAutoEntries[1],
    ]),
    automatic.state,
  )
  assert.deepEqual(
    restoreReviewDutyState([
      {
        type: "custom",
        customType: REVIEW_DUTY_STATE_ENTRY,
        data: { phase: "active", pullRequest: -1 },
      },
    ]),
    emptyReviewDutyState,
  )
})
