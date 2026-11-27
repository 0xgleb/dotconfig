import assert from "node:assert/strict"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import { chromeInset } from "../shared/chrome.ts"
import {
  alignFooterLine,
  formatFooter,
  type FooterPresentation,
} from "./presentation.ts"

const input: FooterPresentation = {
  cwd: "~/code/st0x",
  branch: "feat/footer",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high",
  contextPercent: 12.34,
  contextWindow: 372_000,
}

test("footer is a single readable line with spaced groups", () => {
  const footer = formatFooter(input)

  assert.equal(footer.split("\n").length, 1)
  assert.equal(
    footer,
    "~/code/st0x (feat/footer) · ctx 12.3% of 372k · gpt-5.6-sol / high",
  )
})

test("narrow panes shorten location before dropping context or model details", () => {
  const line = formatFooter(
    { ...input, cwd: "~/code/dataclique/dex-offender", branch: "main" },
    68,
  )
  assert.equal(visibleWidth(line), 68)
  assert.match(
    line,
    /\.\.\.\/dex-offender \(main\) +· +ctx 12\.3% of 372k +· +gpt-5\.6-sol \/ high/,
  )
})

test("narrow footer preserves a short home path without embedded color resets", () => {
  const line = formatFooter(
    {
      ...input,
      cwd: "~/.config",
      branch: "gitbutler/workspace",
      modelId: "gpt-6.2-sol",
      contextWindow: 500_000,
      contextPercent: 72.6,
    },
    70,
  )
  assert.equal(visibleWidth(line), 70)
  assert.ok(line.includes("~/.config (gitbutler/workspace)"))
  assert.ok(line.includes("500k") && line.includes("72.6%"))
  assert.ok(line.includes("gpt-6.2-sol") && line.includes("high"))
  assert.ok(!line.includes("\x1b"))
})

test("wide panes distribute groups across the available width", () => {
  const line = formatFooter(input, 120)
  assert.equal(visibleWidth(line), 120)
  assert.ok(line.indexOf("ctx") > 35)
  assert.ok(line.endsWith("gpt-5.6-sol / high "))
})

test("footer shares the pane-relative chrome gutter at adjacent widths", () => {
  const footer = formatFooter(input)
  for (const width of [79, 80, 81, 119, 120, 121]) {
    const line = alignFooterLine(footer, width)
    assert.equal(visibleWidth(line), width)
    assert.equal(line.search(/\S/u), chromeInset(width))
  }
})

test("footer removes ambiguous built-in abbreviations and auto labels", () => {
  const footer = formatFooter(input)
  assert.doesNotMatch(footer, /\bCH\b/)
  assert.doesNotMatch(footer, /\(auto\)|auto-classifier/i)
})

test("footer formats million-token context windows accurately", () => {
  assert.match(
    formatFooter({ ...input, contextWindow: 1_050_000 }),
    /ctx 12\.3% of 1\.1M/,
  )
})

test("footer handles unknown usage without inventing a percentage", () => {
  assert.match(
    formatFooter({
      ...input,
      contextPercent: undefined,
    }),
    /ctx \? of 372k/,
  )
})
