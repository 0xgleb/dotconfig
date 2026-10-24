import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Extension-source content assertions (classifier tiers, Claude routing in
// agent-process) live with their owning repo (dataclique/metagenda) after the
// pi-source migration. This file pins only the dotconfig-owned review skills.
const reviewCore = readFileSync(
  new URL("../skills/review-core/SKILL.md", import.meta.url),
  "utf8",
)
const reviewLoop = readFileSync(
  new URL("../skills/review-loop/SKILL.md", import.meta.url),
  "utf8",
)
const reviewPr = readFileSync(
  new URL("../skills/review-pr/SKILL.md", import.meta.url),
  "utf8",
)

test("Pi workflows never route Claude through API providers", () => {
  assert.match(reviewCore, /Anthropic API billing is disabled/i)
  assert.match(reviewCore, /claude -p --permission-mode plan/i)
  assert.match(
    reviewPr,
    /Never send `fable`, `sonnet`, `opus`, `claude-\*`, or/i,
  )
})

test("review workflow children receive an explicit repository cwd and least-privilege tools", () => {
  assert.match(reviewCore, /cwd: repoRoot/)
  assert.match(
    reviewCore,
    /tools: lane\.externalCmd[\s\S]*?\['read', 'grep', 'find', 'ls', 'bash'\][\s\S]*?: sourceTools/,
  )
  assert.match(
    reviewCore,
    /label: `verify:\$\{finding\.file\}`[\s\S]*?cwd: repoRoot[\s\S]*?tools: sourceTools/,
  )
})

test("review-pr lanes get bounded no-checkout access to the exact PR-head git object", () => {
  assert.match(reviewPr, /"sourceRevision": "<head_sha>"/)
  assert.match(reviewCore, /sourceRevision/)
  assert.match(reviewCore, /\^\[0-9a-f\]\{40,64\}\$/)
  assert.match(reviewCore, /const sourceTools = gitObjectSource[\s\S]*?'bash'/)
  assert.match(reviewCore, /tools: lane\.externalCmd[\s\S]*?: sourceTools/)
  assert.match(
    reviewCore,
    /label: `verify:\$\{finding\.file\}`[\s\S]*?tools: sourceTools/,
  )
  assert.match(reviewCore, /label: 'synthesize'[\s\S]*?tools: sourceTools/)
  assert.match(reviewCore, /Never read `\.env\*`/)
  assert.match(reviewCore, /credential stores, private keys, or certificates/)
})

test("Claude review-duty adapters stay inside the subscription harness", () => {
  for (const [name, contents] of [
    ["review loop", reviewLoop],
    ["review PR", reviewPr],
  ] as const) {
    assert.match(contents, /Claude Code review-duty harness adapter/)
    assert.match(contents, /CLAUDE_REVIEW_HANDOFF v1/)
    assert.match(contents, /independent native Fable verifier/)
    assert.match(contents, /pi-bridge send/)
    assert.match(
      contents,
      /Never invoke\s+Claude through Pi, an Anthropic API provider/i,
    )
    assert.match(contents, /Missing subscription auth or Fable is `blocked`/)
  }
})

test("review lanes resolve through provider tiers instead of one hardcoded provider", () => {
  for (const [name, contents] of [
    ["review core", reviewCore],
    ["review loop", reviewLoop],
    ["review PR", reviewPr],
  ] as const) {
    assert.doesNotMatch(
      contents,
      /gpt-5\.4-mini/,
      `${name} must not regress below GPT-5.6`,
    )
    assert.doesNotMatch(
      contents,
      /model: 'openai-codex\/gpt-5\.6-luna'/,
      `${name} must not hardcode one provider's model in a lane cell`,
    )
    assert.doesNotMatch(
      contents,
      /model: "openai-codex\/gpt-5\.6-luna"/,
      `${name} must not hardcode one provider's model in a lane cell`,
    )
  }
  assert.match(reviewCore, /provider tier/)
  assert.match(reviewCore, /PI_PROVIDER/)
  assert.match(reviewCore, /zai\/glm-5\.3-flash/)
  assert.match(reviewCore, /gpt-5\.6-luna/)
  assert.match(reviewCore, /model: lightModel/)
  assert.match(reviewCore, /model: midModel/)
  assert.match(reviewLoop, /tierModels\?\.light/)
  assert.match(reviewLoop, /tierModels/)
})
