import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url), "utf8");

test("classifier execution evidence carries the structured tool-result status", () => {
  assert.match(source, /toolResultExecutionEvidence\(\{/);
  assert.match(source, /isError: entry\.message\.isError/);
});
