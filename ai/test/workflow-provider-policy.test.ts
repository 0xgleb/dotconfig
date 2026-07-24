import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agentProcess = readFileSync(
  new URL("../pi/extensions/classified-workflows/agent-process.ts", import.meta.url),
  "utf8",
);
const classifier = readFileSync(
  new URL("../pi/extensions/classified-workflows/index.ts", import.meta.url),
  "utf8",
);
const intentContext = readFileSync(
  new URL("../pi/extensions/classified-workflows/intent-context.ts", import.meta.url),
  "utf8",
);
const reviewCore = readFileSync(new URL("../skills/review-core/SKILL.md", import.meta.url), "utf8");
const reviewLoop = readFileSync(new URL("../skills/review-loop/SKILL.md", import.meta.url), "utf8");
const reviewPr = readFileSync(new URL("../skills/review-pr/SKILL.md", import.meta.url), "utf8");

test("Pi workflows never route Claude through API providers", () => {
  assert.match(agentProcess, /Claude models cannot run through Pi API providers/i);
  assert.match(agentProcess, /external claude -p subscription lane/i);
  assert.match(reviewCore, /Anthropic API billing is disabled/i);
  assert.match(reviewCore, /claude -p --permission-mode plan/i);
  assert.match(reviewPr, /Never send `fable`, `sonnet`, `opus`, `claude-\*`, or/i);
});

test("semantic safety classification uses Sol and bounded relevant evidence while review support stays on Luna", () => {
  assert.match(classifier, /CLASSIFIER_MODEL = "openai-codex\/gpt-5\.6-sol"/);
  assert.match(classifier, /conversationIntentEvidence\(branch\)/);
  assert.match(intentContext, /Human message: \$\{text\}/);
  assert.match(intentContext, /Trusted coordination context: \$\{coordination\}/);
  assert.match(intentContext, /Untrusted assistant context for human co-reference/);
  assert.match(classifier, /assistant report \(untrusted\)/);
  assert.match(classifier, /selectRelevantExecutionEvidence\(executionEvidence, subject\)/);
  assert.doesNotMatch(classifier, /CLASSIFIER_MODEL = "openai-codex\/gpt-5\.6-luna"/);
  for (const [name, contents] of [
    ["review core", reviewCore],
    ["review loop", reviewLoop],
    ["review PR", reviewPr],
  ] as const) {
    assert.doesNotMatch(contents, /gpt-5\.4-mini/, `${name} must not regress below GPT-5.6`);
    assert.match(contents, /gpt-5\.6-luna/, `${name} must use GPT-5.6 Luna for bounded support work`);
  }
});
