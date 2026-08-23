import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const theme = JSON.parse(
  readFileSync(new URL("./archeofuturism.json", import.meta.url), "utf8"),
) as {
  name?: unknown
  vars?: Record<string, unknown>
  colors?: Record<string, unknown>
}

const requiredColors = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const

const syntaxColors = [
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
] as const

test("archeofuturism defines the complete Pi theme surface", () => {
  assert.equal(theme.name, "archeofuturism")
  for (const token of requiredColors)
    assert.ok(theme.colors?.[token] !== undefined, `missing ${token}`)
})

test("routine completion feedback does not reuse addition green", () => {
  const additionGreen = resolveColor(theme.colors?.toolDiffAdded)
  assert.notEqual(resolveColor(theme.colors?.success), additionGreen)
  assert.notEqual(resolveColor(theme.colors?.toolSuccessBg), additionGreen)
})

test("syntax classes are distinct and readable on the dark base", () => {
  const resolved = syntaxColors.map(token =>
    resolveColor(theme.colors?.[token]),
  )
  assert.equal(new Set(resolved).size, syntaxColors.length)
  for (const color of resolved) {
    assert.ok(contrastRatio(color, "#080B1A") >= 3, `${color} lacks contrast`)
  }
})

const resolveColor: (value: unknown) => string = value => {
  assert.equal(typeof value, "string")
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  const variable = theme.vars?.[value]
  assert.equal(typeof variable, "string", `unknown color variable ${value}`)
  assert.match(variable, /^#[0-9a-f]{6}$/i)
  return variable
}

const contrastRatio: (left: string, right: string) => number = (
  left,
  right,
) => {
  const [light, dark] = [luminance(left), luminance(right)].sort(
    (a, b) => b - a,
  )
  return (light + 0.05) / (dark + 0.05)
}

const luminance: (hex: string) => number = hex => {
  const channels =
    hex
      .slice(1)
      .match(/.{2}/g)
      ?.map(channel => Number.parseInt(channel, 16) / 255) ?? []
  const [red = 0, green = 0, blue = 0] = channels.map(channel =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}
