import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const eod = readFileSync(new URL("../skills/eod/SKILL.md", import.meta.url), "utf8");

test("EOD uses bounded Pi session framing without trusting assistant claims", () => {
  assert.match(eod, /bounded `session_search`/i);
  assert.match(eod, /user_framing.*user_correction.*verified_tool_result.*assistant_claim/is);
  assert.match(eod, /Assistant summaries and claims are discovery hints only/i);
  assert.match(eod, /future event-log\s+adapter/i);
  assert.match(eod, /do not add an\s+event-sorcery dependency now/i);
  assert.match(eod, /never read raw.*Pi transcript files/is);
});
