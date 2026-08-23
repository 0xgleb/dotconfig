import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const piInstructions = readFileSync(new URL("../pi/AGENTS.md", import.meta.url), "utf8");
const reviewPr = readFileSync(new URL("../skills/review-pr/SKILL.md", import.meta.url), "utf8");

test("review automation never falls back to a top-level review body", () => {
  assert.doesNotMatch(reviewPr, /fall back to creating a top-level review comment/i);
  assert.match(reviewPr, /Never fall back to a top-level review body/i);
  assert.match(reviewPr, /draft `body` stays empty/i);
});

test("explicit accidental-review cleanup removes exact agent-created content without replacement", () => {
  for (const source of [piInstructions, reviewPr]) {
    assert.match(source, /entire agent-created review.*accidental/is);
    assert.match(source, /inline comments/i);
    assert.match(source, /Never (?:substitute|replace).*marker/is);
    assert.match(source, /exact.*API error/is);
    assert.match(source, /GitHub support/i);
  }
});
