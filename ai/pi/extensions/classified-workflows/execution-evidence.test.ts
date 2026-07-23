import assert from "node:assert/strict";
import test from "node:test";
import { boundedExecutionEvidence } from "./execution-evidence.ts";

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
