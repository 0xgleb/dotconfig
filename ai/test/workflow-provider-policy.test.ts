import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  MODEL_TIER_PROVIDERS,
  type ModelTier,
  tierModel,
} from "../pi/extensions/shared/model-tiers.ts"

// These contracts cover dotconfig-owned review skills, not provider runtimes.
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
const reviewSweep = readFileSync(
  new URL("../skills/review-sweep/SKILL.md", import.meta.url),
  "utf8",
)

const skills = [
  ["review core", reviewCore],
  ["review loop", reviewLoop],
  ["review PR", reviewPr],
  ["review sweep", reviewSweep],
] as const

test("all review skills select authenticated native GPT-6.1-sol lanes", () => {
  for (const [name, contents] of skills) {
    assert.match(contents, /openai-codex\/gpt-6\.1-sol/, name)
    assert.doesNotMatch(contents, /\b(?:sonnet|opus|fable)\b/i, name)
    assert.doesNotMatch(contents, /claude -p|Bash\((?:claude|agy):/, name)
  }
  assert.match(
    reviewCore,
    /const lightModel = ["']openai-codex\/gpt-6\.1-sol["']/,
  )
  assert.match(reviewCore, /const midModel = lightModel/)
  assert.match(
    reviewLoop,
    /const lightModel = ["']openai-codex\/gpt-6\.1-sol["']/,
  )
  assert.doesNotMatch(reviewCore, /tierModels\?\.(?:light|mid)/)
  assert.doesNotMatch(reviewCore, /lane\.externalCmd|fallbackCmds/)
})

test("every inspector table row names the same current model", () => {
  const rows = reviewCore
    .split("\n")
    .filter(line => /^\| [a-z-]+\s+\|/.test(line))
    .map(line => line.split("|").map(cell => cell.trim()))
    .filter(cells => cells[2]?.startsWith("`"))
  assert.equal(rows.length, 21)
  for (const row of rows) {
    assert.equal(row[4], "gpt-6.1-sol", row[1])
  }
})

test("review children retain explicit repository cwd and least-privilege source tools", () => {
  assert.match(reviewCore, /cwd: repoRoot/)
  assert.match(
    reviewCore,
    /label: `review:\$\{lane\.key\}`[\s\S]*?tools: sourceTools/,
  )
  assert.match(
    reviewCore,
    /label: `verify:\$\{finding\.file\}`[\s\S]*?cwd: repoRoot[\s\S]*?tools: sourceTools/,
  )
})

test("PR lanes retain bounded no-checkout access to the exact head object", () => {
  assert.match(reviewPr, /"sourceRevision": "<head_sha>"/)
  assert.match(reviewCore, /\^\[0-9a-f\]\{40,64\}\$/)
  assert.match(
    reviewCore,
    /const sourceTools = gitObjectSource[\s\S]*?["']bash["']/,
  )
  assert.match(
    reviewCore,
    /label: ["']synthesize["'][\s\S]*?tools: sourceTools/,
  )
  assert.match(reviewCore, /Never read\s+(?:\\)?`\.env\*/)
  assert.match(reviewCore, /credential stores, private keys, or certificates/)
})

test("dedicated review-duty adapters use registered gates and native verification", () => {
  for (const contents of [reviewLoop, reviewPr]) {
    assert.match(contents, /review_duty/)
    assert.match(contents, /own\/assigned\/automatic/)
    assert.match(contents, /openai-codex\/gpt-6\.1-sol/)
    assert.doesNotMatch(contents, /CLAUDE_REVIEW_HANDOFF|pi-bridge send/)
  }
})
