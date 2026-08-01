import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { chromeInset } from "../shared/chrome.ts";
import {
  alignFooterLine,
  formatFooter,
  type FooterPresentation,
} from "./presentation.ts";

const input: FooterPresentation = {
  cwd: "~/code/st0x",
  branch: "feat/footer",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high",
  contextPercent: 12.34,
  contextWindow: 372_000,
  cacheHitRate: 98.76,
  inputTokens: 12_400,
  outputTokens: 4_200,
  statuses: ["/goal · 2 turns"],
};

test("footer is a single readable line with spaced groups", () => {
  const footer = formatFooter(input);

  assert.equal(footer.split("\n").length, 1);
  assert.equal(
    footer,
    "~/code/st0x (feat/footer)  ·  ctx 12.3% of 372k  ·  cache 98.8%  ·  ↑12k ↓4.2k  ·  gpt-5.6-sol / high  ·  /goal · 2 turns",
  );
});

test("footer shares the pane-relative chrome gutter at adjacent widths", () => {
  const footer = formatFooter(input);
  for (const width of [79, 80, 81, 119, 120, 121]) {
    const line = alignFooterLine(footer, width);
    assert.equal(visibleWidth(line), width);
    assert.equal(line.search(/\S/u), chromeInset(width));
  }
});

test("footer removes ambiguous built-in abbreviations and auto labels", () => {
  const footer = formatFooter(input);
  assert.doesNotMatch(footer, /\bCH\b/);
  assert.doesNotMatch(footer, /\(auto\)|auto-classifier/i);
});

test("footer formats million-token context windows accurately", () => {
  assert.match(formatFooter({ ...input, contextWindow: 1_050_000 }), /ctx 12\.3% of 1\.1M/);
});

test("footer handles unknown usage without inventing a percentage", () => {
  assert.match(formatFooter({ ...input, contextPercent: undefined, cacheHitRate: undefined }), /ctx \? of 372k/);
});
