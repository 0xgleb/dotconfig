import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

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

const setupSection = (source: string): string => {
  const start = source.indexOf("\n## 2.")
  const end = source.indexOf("\n## 3.", start)

  assert.ok(start >= 0 && end > start, "review setup section must exist")
  return source.slice(start, end)
}

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

test("review setup uses fail-closed native UUID invocation namespaces", () => {
  for (const contents of [reviewLoop, reviewPr]) {
    const setup = setupSection(contents)

    assert.match(setup, /invocation_id=\$\(uuidgen\)\s*\|\|\s*exit 1/)
    assert.match(setup, /out_dir=.*invocation_id/)
    assert.doesNotMatch(setup, /ts=\$\(date/)
  }
})

test("review setup records successful registered creation between ignore checks and writes", () => {
  for (const contents of [reviewLoop, reviewPr]) {
    const setup = setupSection(contents)
    const fromSetup = contents
      .slice(contents.indexOf("\n## 2."))
      .replace(/\s+/gu, " ")
    const ignore = fromSetup.indexOf("git check-ignore --verbose")
    const create = fromSetup.indexOf('"action": "create_directory"')
    const success = fromSetup.indexOf(
      "Require successful creation and provenance recording before writing descendants.",
    )
    const write = fromSetup.indexOf('> "$out_dir/diff.patch"')

    assert.ok(
      ignore >= 0 && create > ignore && success > create && write > success,
    )
    assert.doesNotMatch(setup, /^\s*mkdir\s+-p\b/m)
    assert.match(contents, /allowed-tools:.*artifact_provenance/)
  }
})

test("the Markdown consistency child uses the actual review checkout cwd", () => {
  assert.match(
    reviewLoop,
    /\{\s*cwd: repoRoot,\s*label: ["']markdown-consistency["']/,
  )
})

test("incomplete Markdown coverage enters the existing lane error channel", () => {
  const start = reviewCore.indexOf("Shared context block")
  const end = reviewCore.indexOf("\n## 4.", start)

  assert.ok(start >= 0 && end > start)
  const context = reviewCore.slice(start, end).replace(/\s+/gu, " ")

  assert.match(context, /incomplete.*reviewer_error.*partial.*clean_reason/)
})
