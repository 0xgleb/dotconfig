import assert from "node:assert/strict";
import test from "node:test";

import {
  coherenceDiagnostic,
  HANDOFF_GLOBS,
  isSafeHandoffName,
  MANAGED_SETTLE_GATE_START,
  managedPiChangeLabel,
  managedReloadDecision,
  managedPiWatchPaths,
  managedSettleGateChanged,
  managedSettleGateObserve,
  parseManagedReloadSummary,
  parseSeenHandoffNames,
  managedReloadDelivery,
  parseReloadResumeMarker,
  shouldDispatchReloadFollowUp,
  unseenHandoffNames,
  type ManagedExtensionSet,
  type ManagedSettleGate,
} from "./core.ts";
import { CONTINUATION_PAUSE_ENTRY } from "../shared/continuation-pause.ts";

test("managed reloads preempt long-running turns only after sources settle", () => {
  const base = {
    source: "settled" as const,
    idle: false,
    pendingForMs: 29_999,
    forceAfterMs: 30_000,
    preemptRequested: false,
  };
  assert.equal(managedReloadDecision({ ...base, source: "changing" }), "await-settle");
  assert.equal(
    managedReloadDecision({ ...base, source: "incoherent", idle: true }),
    "await-settle",
    "an idle session must not load a tree that does not hold together",
  );
  assert.equal(
    managedReloadDecision({
      ...base,
      source: "incoherent",
      pendingForMs: 60_000,
    }),
    "await-settle",
    "the forced-reload deadline must never override the coherence gate",
  );
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
      pendingMessages: true,
    }),
    "preempt",
    "queued messages must survive a bounded reload instead of starving it",
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

test("a tree held incoherent past the deadline is explained once instead of silently", () => {
  const held = {
    source: "incoherent" as const,
    pendingForMs: 120_000,
    noticeAfterMs: 120_000,
    announced: false,
  };
  assert.equal(coherenceDiagnostic(held), "report");
  assert.equal(
    coherenceDiagnostic({ ...held, announced: true }),
    "withhold",
    "a wedged tree is named once, not on every retry",
  );
  assert.equal(
    coherenceDiagnostic({ ...held, pendingForMs: 119_999 }),
    "withhold",
    "a change set still landing is not a stuck one",
  );
  assert.equal(coherenceDiagnostic({ ...held, source: "changing" }), "withhold");
  assert.equal(coherenceDiagnostic({ ...held, source: "settled" }), "withhold");
});

test("a reload waits for a quiet window whose snapshot re-reads unchanged", () => {
  const settleMs = 15_000;
  const observe = (
    gate: ManagedSettleGate,
    now: number,
    snapshot: string,
    extensionSet: ManagedExtensionSet = { resolution: "complete" },
  ) =>
    managedSettleGateObserve(gate, {
      now,
      settleMs,
      snapshot,
      extensionSet: () => extensionSet,
    });

  const changed = managedSettleGateChanged(1_000);
  assert.equal(observe(changed, 10_000, "a").source, "changing");

  const firstQuiet = observe(changed, 16_000, "a");
  assert.equal(
    firstQuiet.source,
    "changing",
    "the first reading after the window closes only records the snapshot to compare against",
  );
  assert.equal(observe(firstQuiet.gate, 18_000, "a").source, "settled");

  const moved = observe(firstQuiet.gate, 18_000, "b");
  assert.equal(
    moved.source,
    "changing",
    "a snapshot that moved is a write the watcher never reported, not a settled tree",
  );
  assert.equal(observe(moved.gate, 20_000, "b").source, "settled");

  assert.equal(
    observe(firstQuiet.gate, 18_000, "a", {
      resolution: "incomplete",
      unresolved: "./shared/lane.ts imported by /extensions/sample/index.ts",
    }).source,
    "incoherent",
    "a quiet tree that does not resolve is a half-written change set",
  );

  const reopened = observe(managedSettleGateChanged(19_000), 20_000, "a");
  assert.equal(reopened.source, "changing");
  assert.equal(reopened.gate.settleSnapshot, undefined);
  assert.equal(MANAGED_SETTLE_GATE_START.settleSnapshot, undefined);
});

test("the extension set is only walked once the quiet window has closed on a stable snapshot", () => {
  let walks = 0;
  const extensionSet = (): ManagedExtensionSet => {
    walks += 1;
    return { resolution: "complete" };
  };
  const observation = { settleMs: 15_000, snapshot: "a", extensionSet };
  const changed = managedSettleGateChanged(1_000);
  const early = managedSettleGateObserve(changed, { ...observation, now: 5_000 });
  assert.equal(walks, 0);
  const firstQuiet = managedSettleGateObserve(early.gate, { ...observation, now: 17_000 });
  assert.equal(walks, 0);
  assert.equal(
    managedSettleGateObserve(firstQuiet.gate, { ...observation, now: 19_000 }).source,
    "settled",
  );
  assert.equal(walks, 1);
});

test("managed reload resumes each interrupted generation before preserved follow-ups", () => {
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
  assert.equal(
    managedReloadDelivery("reload", [pendingResume], false),
    "resume",
  );
  assert.equal(managedReloadDelivery("reload", [resumed], true), "display");
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
  );
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
  );
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
