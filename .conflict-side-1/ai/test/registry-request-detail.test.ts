import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/agent-registry/index.ts", import.meta.url), "utf8");

test("same-owner claim_request is idempotent and returns full request detail", () => {
  assert.match(source, /target\.status === "claimed"/);
  assert.match(source, /target\.leaseId === lease\.id/);
  assert.match(source, /target\.agentId === agent\.id/);
  assert.match(source, /outcome: "already_claimed"/);
  assert.match(source, /registryRequestDetailText\(target\)/);
});

test("new claims return the request detail rather than a body-free acknowledgement", () => {
  assert.match(source, /registryRequestDetailText\(claimed\)/);
});
