import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { promptChromeBottomLine, promptChromeTopLine } from "../chrome.ts";

test("prompt chrome uses aligned structural rails without a filled background", () => {
  const top = promptChromeTopLine(48);
  const bottom = promptChromeBottomLine(48, "◈ INSERT");

  assert.equal(visibleWidth(top), 48);
  assert.equal(visibleWidth(bottom), 48);
  assert.match(top, /^╼ PROMPT  ━+$/);
  assert.match(bottom, /^━+ ◈ INSERT ╾$/);
  assert.equal(top.includes("\x1b[4"), false);
  assert.equal(bottom.includes("\x1b[4"), false);
});
