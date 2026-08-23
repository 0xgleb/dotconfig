import assert from "node:assert/strict"
import test from "node:test"

import {
  highlightFileContent,
  highlightUnifiedDiff,
  type CodeHighlighter,
  type CodeRenderingTheme,
} from "./rendering.ts"

const calls: Array<{ code: string; language?: string }> = []
const highlighter: CodeHighlighter = (code, language) => {
  calls.push({ code, language })
  return code.split("\n").map(line => `<syntax>${line}</syntax>`)
}

const theme = {
  fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
  bg: (color: string, text: string) => `\x1b[48;2;1;2;3m<bg:${color}>${text}</bg>\x1b[49m`,
} as CodeRenderingTheme

test("read output uses the file language highlighter", () => {
  calls.length = 0
  const rendered = highlightFileContent(
    "src/router.ts",
    "const route = 1",
    () => "typescript",
    highlighter,
  )

  assert.equal(rendered, "<syntax>const route = 1</syntax>")
  assert.deepEqual(calls, [{ code: "const route = 1", language: "typescript" }])
})

test("diff output layers semantic colors over language syntax", () => {
  calls.length = 0
  const rendered = highlightUnifiedDiff(
    "src/router.ts",
    "@@ -1 +1 @@\n-const oldRoute = 1\n+const newRoute = 2\n const stable = true",
    theme,
    () => "typescript",
    highlighter,
  )

  assert.match(rendered, /<fg:dim>@@ -1 \+1 @@<\/fg>/)
  assert.match(rendered, /<bg:toolErrorBg>.*<fg:toolDiffRemoved>-<\/fg><syntax>const oldRoute = 1<\/syntax>/)
  assert.match(rendered, /<bg:toolSuccessBg>.*<fg:toolDiffAdded>\+<\/fg><syntax>const newRoute = 2<\/syntax>/)
  assert.match(rendered, /<fg:toolDiffContext> <\/fg><syntax>const stable = true<\/syntax>/)
  assert.equal(calls.every(call => call.language === "typescript"), true)
})
