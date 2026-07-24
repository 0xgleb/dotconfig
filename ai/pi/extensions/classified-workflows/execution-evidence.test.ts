import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedExecutionEvidence,
  boundedRelevantExecutionEvidence,
  selectRelevantExecutionEvidence,
  toolInputDigest,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts";

test("large GraphQL tool results retain bounded thread IDs, authors, and resolution state", () => {
  const threads = Array.from({ length: 20 }, (_, index) => ({
    id: `THREAD_${index}`,
    isResolved: false,
    author: { login: index % 2 === 0 ? "coderabbitai" : "graphite-app" },
    body: "x".repeat(600),
  }));
  const evidence = boundedExecutionEvidence(JSON.stringify({ threads }));
  assert.ok(evidence.length <= 4_000);
  assert.match(evidence, /structured fields:/);
  assert.match(evidence, /id="THREAD_19"/);
  assert.match(evidence, /login="graphite-app"/);
  assert.match(evidence, /isResolved=false/);
  assert.doesNotMatch(evidence, /x{200}/);
});

test("short tool results remain intact and diagnostics are sanitized", () => {
  assert.equal(
    boundedExecutionEvidence('{"login":"coderabbitai","token":"sensitive-value"}'),
    '{"login":"coderabbitai","token":"[REDACTED]"}',
  );
});

test("subject-aware bounding retains verified draft-comment anchors from the middle of large plans", () => {
  const findings = Array.from({ length: 62 }, (_, index) =>
    `finding ${index}: crates/review/src/check_${index}.rs:${100 + index} ${"detail ".repeat(20)}`,
  );
  findings[31] = `finding 31: crates/issuance/src/lib.rs:605 verified inline comment ${"detail ".repeat(30)}`;
  const evidence = boundedRelevantExecutionEvidence(
    findings.join("\n"),
    {
      command: "addPullRequestReviewComment",
      path: "crates/issuance/src/lib.rs",
      line: 605,
      reviewId: "PRR_kwDORISeF88AAAABHE8fRQ",
    },
    900,
  );
  assert.ok(evidence.length <= 900);
  assert.match(evidence, /crates\/issuance\/src\/lib\.rs:605/);
  assert.match(evidence, /verified inline comment/);
  assert.doesNotMatch(evidence, /finding 0:/);
});

test("tool-input digests are canonical and distinguish materially new mutation payloads", () => {
  const first = toolInputDigest("skill_manage", {
    action: "patch",
    skill_id: "project:yielduck:close-orders",
    section: "Procedure",
    content: "current wallet balance",
  });
  const reordered = toolInputDigest("skill_manage", {
    content: "current wallet balance",
    section: "Procedure",
    skill_id: "project:yielduck:close-orders",
    action: "patch",
  });
  const newContent = toolInputDigest("skill_manage", {
    action: "patch",
    skill_id: "project:yielduck:close-orders",
    section: "Procedure",
    content: "chain-attested balance with a fresh projection witness",
  });

  assert.equal(first, reordered);
  assert.notEqual(first, newContent);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("tool-result evidence preserves authoritative success or error status and input identity", () => {
  const inputDigest = toolInputDigest("edit", { oldText: "pre-transfer Core balance" });
  const failedEdit = toolResultExecutionEvidence({
    toolName: "edit",
    text: "oldText not found; replacement may already be present",
    isError: true,
    inputDigest,
    subject: { toolName: "edit", input: { oldText: "pre-transfer Core balance" } },
  });
  const currentRead = toolResultExecutionEvidence({
    toolName: "read",
    text: "Bind the episode to the pre-transfer Core balance",
    isError: false,
    subject: { toolName: "edit", input: { oldText: "pre-transfer Core balance" } },
  });

  assert.match(failedEdit, new RegExp(`^edit result status=error inputDigest=${inputDigest}:`));
  assert.match(currentRead, /^read result status=success:/);
});

test("evidence retrieval keeps recent results and older results sharing concrete subject identifiers", () => {
  const candidates = [
    "gh: PR 164 head 87ca2acebed26600fb08ee995c9c3c11fa558a05 verified four findings",
    "git: unrelated branch status",
    "read: another unrelated result",
    "gh: latest generic result",
  ];
  assert.deepEqual(
    selectRelevantExecutionEvidence(
      candidates,
      { command: "add pending review for PR 164 at 87ca2acebed26600fb08ee995c9c3c11fa558a05" },
      2,
      2,
    ),
    [candidates[0], candidates[2], candidates[3]],
  );
});
