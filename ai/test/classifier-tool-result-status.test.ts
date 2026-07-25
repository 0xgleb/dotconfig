import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url), "utf8");

test("classifier execution evidence carries structured result status and mutation identity", () => {
  assert.match(source, /toolResultExecutionEvidence\(\{/);
  assert.match(source, /isError: entry\.message\.isError/);
  assert.match(source, /toolCallInputDigests/);
  assert.match(source, /inputDigest: toolInputDigest\(event\.toolName, event\.input\)/);
  assert.match(source, /inputDigest:[\s\S]{0,160}toolCallInputDigests\.get/);
});

test("a duplicate-only classifier mistake yields to newer exact read evidence", () => {
  assert.match(source, /currentReadDisprovesDuplicateBlock\(\{/);
  assert.match(source, /reason: decision\.reason/);
  assert.match(source, /branch: ctx\.sessionManager\.getBranch\(\)/);
});
