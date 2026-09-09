import assert from "node:assert/strict"
import test from "node:test"

import {
  HANDOFF_GLOBS,
  isSafeHandoffName,
  managedPiChangeLabel,
  managedReloadDecision,
  managedReloadDisplayText,
  managedPiWatchPaths,
  parseManagedReloadSummary,
  parseSeenHandoffNames,
  reloadComposerIsSafe,
  managedReloadDelivery,
  RELOAD_FOLLOW_UP_ENTRY,
  RELOAD_HUMAN_INPUT_ENTRY,
  RELOAD_RESUME_ENTRY,
  parseReloadResumeMarker,
  shouldDispatchReloadFollowUp,
  unseenHandoffNames,
} from "./core.ts"
import { CONTINUATION_PAUSE_ENTRY } from "../shared/continuation-pause.ts"

test("managed reloads never seize a non-empty or queued composer", () => {
  assert.equal(
    reloadComposerIsSafe({
      editorText: "",
      pendingMessages: false,
      compactionActive: false,
    }),
    true,
  )
  for (const unsafe of [
    { editorText: "draft", pendingMessages: false, compactionActive: false },
    { editorText: " ", pendingMessages: false, compactionActive: false },
    { editorText: "", pendingMessages: true, compactionActive: false },
    { editorText: "", pendingMessages: false, compactionActive: true },
  ])
    assert.equal(reloadComposerIsSafe(unsafe), false)
})

test("managed reloads wait for active turns and never preempt queued work", () => {
  const base = {
    settled: true,
    idle: false,
    pendingForMs: 29_999,
    forceAfterMs: 30_000,
    preemptRequested: false,
  }
  assert.equal(
    managedReloadDecision({ ...base, settled: false }),
    "await-settle",
  )
  assert.equal(managedReloadDecision({ ...base, idle: true }), "reload")
  assert.equal(managedReloadDecision(base), "wait")
  assert.equal(managedReloadDecision({ ...base, pendingForMs: 30_000 }), "wait")
  assert.equal(
    managedReloadDecision({
      ...base,
      pendingForMs: 60_000,
      pendingMessages: true,
    }),
    "wait",
    "queued messages must never be preempted by a managed reload",
  )
  assert.equal(
    managedReloadDecision({
      ...base,
      pendingForMs: 60_000,
      preemptRequested: true,
    }),
    "wait",
  )
})

test("malformed newer resume state cannot hide an older valid pending marker", () => {
  const validPending = {
    type: "custom",
    customType: "auto-reload.preempted-generation",
    data: { requestedAt: 123, status: "pending" },
  }
  const malformedNewer = {
    type: "custom",
    customType: "auto-reload.preempted-generation",
    data: { requestedAt: "later", status: "resumed" },
  }

  assert.deepEqual(
    parseReloadResumeMarker(validPending.data),
    validPending.data,
  )
  assert.equal(parseReloadResumeMarker(malformedNewer.data), undefined)
  assert.equal(
    managedReloadDelivery("reload", [validPending, malformedNewer], false),
    "resume",
  )
})

test("managed reload resumes each interrupted generation before preserved follow-ups", () => {
  const pendingResume = {
    type: "custom",
    customType: "auto-reload.preempted-generation",
    data: { requestedAt: 123, status: "pending" },
  }
  const resumed = {
    ...pendingResume,
    data: { requestedAt: 123, status: "resumed" },
  }
  const pendingQuestion = {
    type: "custom",
    customType: "pi.questions.state",
    data: {
      questions: [
        { id: 8, status: "pending", question: "Approve release input?" },
      ],
      nextId: 9,
    },
  }
  assert.deepEqual(parseReloadResumeMarker(pendingResume.data), {
    requestedAt: 123,
    status: "pending",
  })
  assert.equal(managedReloadDelivery("reload", [pendingResume], true), "resume")
  assert.equal(
    managedReloadDelivery("reload", [pendingResume], false),
    "resume",
  )
  assert.equal(managedReloadDelivery("reload", [resumed], true), "display")
  assert.equal(
    managedReloadDelivery("reload", [pendingResume, pendingQuestion], false),
    "displayAndConsumeResume",
    "an unanswered human gate consumes an interrupted-generation marker without injecting a no-op resume",
  )
  assert.equal(
    managedReloadDelivery(
      "reload",
      [
        pendingResume,
        resumed,
        {
          ...pendingResume,
          data: { requestedAt: 456, status: "pending" },
        },
      ],
      true,
    ),
    "resume",
    "a later reload gets exactly one new resume without replaying the old one",
  )
  assert.equal(
    managedReloadDelivery(
      "reload",
      [
        pendingResume,
        resumed,
        {
          ...pendingResume,
          data: { requestedAt: 456, status: "pending" },
        },
        {
          ...pendingResume,
          data: { requestedAt: 456, status: "resumed" },
        },
      ],
      true,
    ),
    "display",
  )
})

test("reload does not duplicate a queued or unanswered managed continuation", () => {
  const pendingTodo = {
    type: "custom",
    customType: "todo.state",
    data: {
      todos: [{ id: 1, text: "continue", status: "pending", replies: [] }],
      nextId: 2,
    },
  }
  const priorReloadWake = {
    type: "custom",
    customType: RELOAD_FOLLOW_UP_ENTRY,
    data: { requestedAt: 123 },
  }
  const priorReloadResume = {
    type: "custom",
    customType: RELOAD_RESUME_ENTRY,
    data: { requestedAt: 123, status: "resumed" },
  }
  const extensionLoopContinuation = {
    type: "message",
    id: "loop-user-message",
    message: {
      role: "user",
      content: "Recurring loop run #7 (infinite):\n/register",
    },
  }
  const humanContinuation = {
    type: "message",
    id: "human-user-message",
    message: { role: "user", content: "Continue" },
  }
  const humanInputMarker = {
    type: "custom",
    customType: RELOAD_HUMAN_INPUT_ENTRY,
    data: { observedAt: 456 },
  }
  assert.equal(managedReloadDelivery("reload", [pendingTodo], true), "display")
  assert.equal(
    managedReloadDelivery("reload", [pendingTodo], false),
    "followUp",
  )
  assert.equal(
    managedReloadDelivery("reload", [pendingTodo, priorReloadWake], false),
    "display",
    "a later source generation must not inject another turn before new human input",
  )
  assert.equal(
    managedReloadDelivery("reload", [pendingTodo, priorReloadResume], false),
    "display",
    "a completed interrupted-generation resume suppresses later reload wakes",
  )
  assert.equal(
    managedReloadDelivery(
      "reload",
      [pendingTodo, priorReloadWake, extensionLoopContinuation],
      false,
    ),
    "display",
    "extension-generated user messages must not rearm reload continuations",
  )
  assert.equal(
    managedReloadDelivery(
      "reload",
      [pendingTodo, priorReloadWake, humanContinuation],
      false,
    ),
    "display",
    "untyped user-shaped session entries cannot prove human input",
  )
  assert.equal(
    managedReloadDelivery(
      "reload",
      [pendingTodo, humanInputMarker, priorReloadWake],
      false,
    ),
    "display",
    "a human input already consumed by the prior wake cannot rearm it again",
  )
  assert.equal(
    managedReloadDelivery(
      "reload",
      [pendingTodo, priorReloadWake, humanContinuation, humanInputMarker],
      false,
    ),
    "followUp",
    "a trusted later human-input marker rearms one managed continuation",
  )
})

test("managed reload display makes the changed capability the whole message", () => {
  assert.equal(
    managedReloadDisplayText(["safe-compaction extension"]),
    "↻ Reloaded · safe-compaction extension",
  )
  assert.equal(
    managedReloadDisplayText(["Pi configuration", "safe-compaction extension"]),
    "↻ Reloaded · Pi configuration, safe-compaction extension",
  )
  assert.equal(managedReloadDisplayText([]), "↻ Reloaded")
  assert.equal(
    managedReloadDisplayText([], "model catalog refresh timed out"),
    "⚠ Reload incomplete · model catalog refresh timed out",
  )
})

test("managed reload summaries identify changed capabilities without exposing full paths", () => {
  const root = "/Users/example/.config/ai"
  assert.equal(
    managedPiChangeLabel(
      `${root}/pi/extensions/classified-workflows/index.ts`,
      root,
    ),
    "classified-workflows extension",
  )
  assert.equal(
    managedPiChangeLabel(`${root}/skills/pi-delegation/SKILL.md`, root),
    "pi-delegation skill",
  )
  assert.deepEqual(
    parseManagedReloadSummary({
      labels: ["questions extension", "questions extension"],
      createdAt: 42,
      announced: false,
    }),
    { labels: ["questions extension"], createdAt: 42, announced: false },
  )
  assert.equal(
    parseManagedReloadSummary({ labels: [7], createdAt: 42, announced: false }),
    undefined,
  )
})

test("malformed question items fail closed before reload continuation", () => {
  const pendingTodo = {
    type: "custom",
    customType: "todo.state",
    data: {
      todos: [{ id: 1, text: "Continue", status: "pending" }],
      nextId: 2,
    },
  }
  const malformedQuestionState = {
    type: "custom",
    customType: "pi.questions.state",
    data: { questions: [null] },
  }

  assert.equal(
    shouldDispatchReloadFollowUp("reload", [
      pendingTodo,
      malformedQuestionState,
    ]),
    false,
  )
})

test("auto reload triggers turns for active work and blockers that the new generation may resolve", () => {
  const pendingTodo = {
    type: "custom",
    customType: "todo.state",
    data: {
      todos: [{ id: 1, text: "Continue", status: "pending" }],
      nextId: 2,
    },
  }
  const blockedTodo = {
    type: "custom",
    customType: "todo.state",
    data: {
      todos: [
        {
          id: 1,
          text: "Wait",
          status: "blocked",
          reason: "external dependency",
        },
      ],
      nextId: 2,
    },
  }
  const pendingQuestion = {
    type: "custom",
    customType: "pi.questions.state",
    data: {
      questions: [
        { id: 7, status: "pending", question: "Approve this review?" },
      ],
      nextId: 8,
    },
  }
  const malformedNewerQuestionState = {
    type: "custom",
    customType: "pi.questions.state",
    data: { questions: "unknown" },
  }
  const malformedQuestionItemState = {
    type: "custom",
    customType: "pi.questions.state",
    data: { questions: [null] },
  }
  assert.equal(shouldDispatchReloadFollowUp("reload", []), false)
  assert.equal(shouldDispatchReloadFollowUp("reload", [pendingTodo]), true)
  assert.equal(
    shouldDispatchReloadFollowUp("reload", [blockedTodo]),
    false,
    "blocked work alone is passive and must not cause reload wake loops",
  )
  assert.equal(
    shouldDispatchReloadFollowUp("reload", [blockedTodo, pendingQuestion]),
    false,
    "a user-gated blocked session must stay passive across managed reloads",
  )
  assert.equal(
    shouldDispatchReloadFollowUp("reload", [pendingTodo, pendingQuestion]),
    false,
    "the typed user gate suppresses generic todo and goal wakes until answered",
  )
  assert.equal(
    shouldDispatchReloadFollowUp("reload", [
      pendingTodo,
      pendingQuestion,
      malformedNewerQuestionState,
    ]),
    false,
    "malformed newer question state must fail closed instead of hiding a pending gate",
  )
  assert.equal(
    shouldDispatchReloadFollowUp("reload", [
      pendingTodo,
      malformedQuestionItemState,
    ]),
    false,
    "malformed question items must fail closed",
  )
  assert.equal(shouldDispatchReloadFollowUp("resume", [pendingTodo]), false)
  assert.equal(
    shouldDispatchReloadFollowUp("reload", [
      pendingTodo,
      {
        type: "custom",
        customType: CONTINUATION_PAUSE_ENTRY,
        data: { paused: true, updatedAt: 42 },
      },
    ]),
    false,
  )
})

test("auto reload watches only managed Pi source roots", () => {
  assert.deepEqual(managedPiWatchPaths("/Users/example/.config/ai"), [
    "/Users/example/.config/ai/AGENTS.md",
    "/Users/example/.config/ai/pi.settings.json",
    "/Users/example/.config/ai/pi/AGENTS.md",
    "/Users/example/.config/ai/pi/extensions",
    "/Users/example/.config/ai/pi/themes",
    "/Users/example/.config/ai/skills",
  ])
  assert.equal(managedPiWatchPaths("relative").length, 0)
})

test("handoff watcher accepts only direct visible Markdown filenames", () => {
  assert.equal(isSafeHandoffName("2026-07-22-pi-browser.md"), true)
  assert.equal(isSafeHandoffName("nested/pi.md"), false)
  assert.equal(isSafeHandoffName("../pi.md"), false)
  assert.equal(isSafeHandoffName(".hidden.md"), false)
  assert.equal(isSafeHandoffName("pi.txt"), false)
  assert.equal(isSafeHandoffName("unrelated-notes.md"), false)
  assert.equal(
    isSafeHandoffName("handoffs/2026-07-22-classified-workflow-budget.md"),
    true,
  )
  assert.equal(isSafeHandoffName("other/2026-pi-request.md"), false)
  assert.equal(isSafeHandoffName("handoffs/nested/pi-request.md"), false)
  assert.deepEqual(HANDOFF_GLOBS, ["*.md", "handoffs/*.md"])
})

test("persisted handoff names are decoded defensively", () => {
  assert.deepEqual(
    parseSeenHandoffNames({ names: ["pi-one.md", "handoff-two.md"] }),
    ["pi-one.md", "handoff-two.md"],
  )
  assert.deepEqual(parseSeenHandoffNames({ names: ["pi-one.md", 7] }), [])
  assert.deepEqual(parseSeenHandoffNames(null), [])
})

test("handoff reconciliation returns safe unseen Pi requests", () => {
  assert.deepEqual(
    unseenHandoffNames(
      [
        "2026-pi-browser.md",
        "handoff-classifier.md",
        "handoffs/classified-workflow-budget.md",
        "unrelated.md",
        ".hidden-pi.md",
      ],
      new Set(["2026-pi-browser.md"]),
    ),
    ["handoff-classifier.md", "handoffs/classified-workflow-budget.md"],
  )
})
