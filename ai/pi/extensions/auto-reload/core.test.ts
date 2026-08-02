import assert from "node:assert/strict";
import test from "node:test";

import {
  HANDOFF_GLOBS,
  isSafeHandoffName,
  managedPiChangeLabel,
  managedReloadDecision,
  managedPiWatchPaths,
  parseManagedReloadSummary,
  parseSeenHandoffNames,
  managedReloadDelivery,
  parseReloadResumeMarker,
  shouldDispatchReloadFollowUp,
  unseenHandoffNames,
} from "./core.ts";
import { CONTINUATION_PAUSE_ENTRY } from "../shared/continuation-pause.ts";

test("managed reloads preempt long-running turns only after a committed grace period", () => {
  const base = {
    committed: true,
    idle: false,
    pendingForMs: 29_999,
    forceAfterMs: 30_000,
    preemptRequested: false,
  };
  assert.equal(managedReloadDecision({ ...base, committed: false }), "await-commit");
  assert.equal(managedReloadDecision({ ...base, idle: true }), "reload");
  assert.equal(managedReloadDecision(base), "wait");
  assert.equal(
    managedReloadDecision({ ...base, pendingForMs: 30_000 }),
    "preempt",
  );
  assert.equal(
    managedReloadDecision({
      ...base,
      pendingForMs: 60_000,
      preemptRequested: true,
    }),
    "wait",
  );
});

test("managed reload resumes a preempted generation before preserved follow-ups", () => {
  const pendingResume = {
    type: "custom",
    customType: "auto-reload.preempted-generation",
    data: { requestedAt: 123, status: "pending" },
  };
  const resumed = {
    ...pendingResume,
    data: { requestedAt: 123, status: "resumed" },
  };
  assert.deepEqual(parseReloadResumeMarker(pendingResume.data), {
    requestedAt: 123,
    status: "pending",
  });
  assert.equal(
    managedReloadDelivery("reload", [pendingResume], true),
    "resume",
  );
  assert.equal(managedReloadDelivery("reload", [resumed], true), "display");
});

test("reload does not inject a continuation ahead of existing pending messages", () => {
  const pendingTodo = {
    type: "custom",
    customType: "todo.state",
    data: {
      todos: [{ id: 1, text: "continue", status: "pending", replies: [] }],
      nextId: 2,
    },
  };
  assert.equal(managedReloadDelivery("reload", [pendingTodo], true), "display");
  assert.equal(managedReloadDelivery("reload", [pendingTodo], false), "followUp");
});

test("managed reload summaries identify changed capabilities without exposing full paths", () => {
  const root = "/Users/example/.config/ai";
  assert.equal(
    managedPiChangeLabel(`${root}/pi/extensions/classified-workflows/index.ts`, root),
    "classified-workflows extension",
  );
  assert.equal(managedPiChangeLabel(`${root}/skills/pi-delegation/SKILL.md`, root), "pi-delegation skill");
  assert.deepEqual(
    parseManagedReloadSummary({ labels: ["questions extension", "questions extension"], createdAt: 42, announced: false }),
    { labels: ["questions extension"], createdAt: 42, announced: false },
  );
  assert.equal(parseManagedReloadSummary({ labels: [7], createdAt: 42, announced: false }), undefined);
});

test("auto reload triggers turns for active work and blockers that the new generation may resolve", () => {
  const pendingTodo = {
    type: "custom",
    customType: "todo.state",
    data: { todos: [{ id: 1, text: "Continue", status: "pending" }], nextId: 2 },
  };
  const blockedTodo = {
    type: "custom",
    customType: "todo.state",
    data: { todos: [{ id: 1, text: "Wait", status: "blocked", reason: "external dependency" }], nextId: 2 },
  };
  assert.equal(shouldDispatchReloadFollowUp("reload", []), false);
  assert.equal(shouldDispatchReloadFollowUp("reload", [pendingTodo]), true);
  assert.equal(shouldDispatchReloadFollowUp("reload", [blockedTodo]), true);
  assert.equal(shouldDispatchReloadFollowUp("resume", [pendingTodo]), false);
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
  );
});

test("auto reload watches only managed Pi source roots", () => {
  assert.deepEqual(managedPiWatchPaths("/Users/example/.config/ai"), [
    "/Users/example/.config/ai/AGENTS.md",
    "/Users/example/.config/ai/pi.settings.json",
    "/Users/example/.config/ai/pi/AGENTS.md",
    "/Users/example/.config/ai/pi/extensions",
    "/Users/example/.config/ai/pi/themes",
    "/Users/example/.config/ai/skills",
  ]);
  assert.equal(managedPiWatchPaths("relative").length, 0);
});

test("handoff watcher accepts only direct visible Markdown filenames", () => {
  assert.equal(isSafeHandoffName("2026-07-22-pi-browser.md"), true);
  assert.equal(isSafeHandoffName("nested/pi.md"), false);
  assert.equal(isSafeHandoffName("../pi.md"), false);
  assert.equal(isSafeHandoffName(".hidden.md"), false);
  assert.equal(isSafeHandoffName("pi.txt"), false);
  assert.equal(isSafeHandoffName("unrelated-notes.md"), false);
  assert.equal(isSafeHandoffName("handoffs/2026-07-22-classified-workflow-budget.md"), true);
  assert.equal(isSafeHandoffName("other/2026-pi-request.md"), false);
  assert.equal(isSafeHandoffName("handoffs/nested/pi-request.md"), false);
  assert.deepEqual(HANDOFF_GLOBS, ["*.md", "handoffs/*.md"]);
});

test("persisted handoff names are decoded defensively", () => {
  assert.deepEqual(parseSeenHandoffNames({ names: ["pi-one.md", "handoff-two.md"] }), ["pi-one.md", "handoff-two.md"]);
  assert.deepEqual(parseSeenHandoffNames({ names: ["pi-one.md", 7] }), []);
  assert.deepEqual(parseSeenHandoffNames(null), []);
});

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
  );
});
