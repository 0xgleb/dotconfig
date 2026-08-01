import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import {
  PROMPT_MIN_CONTENT_ROWS,
  promptChromeBottomLine,
  promptChromeInset,
  promptChromeTopLine,
} from "../chrome.ts"

const vimEditorSource = readFileSync(
  new URL("../vim-editor.ts", import.meta.url),
  "utf8",
)

test("insert-mode render reasserts the hardware cursor after host reloads", () => {
  assert.match(
    vimEditorSource,
    /render\(width: number\)[\s\S]*?setShowHardwareCursor\(this\.vimState\.mode === "insert"\)[\s\S]*?super\.render/,
  )
})

test("prompt chrome uses a rounded inset frame without a filled background", () => {
  const top = promptChromeTopLine(48)
  const bottom = promptChromeBottomLine(48, "◈ INSERT")

  assert.equal(visibleWidth(top), 48)
  assert.equal(visibleWidth(bottom), 48)
  assert.match(top, /^╭─ PROMPT ─+╮$/)
  assert.match(bottom, /^╰─+ ◈ INSERT ─╯$/)
  assert.equal(top.includes("\x1b[4"), false)
  assert.equal(bottom.includes("\x1b[4"), false)
})

test("prompt reserves more content height than the compact task preview", () => {
  assert.equal(PROMPT_MIN_CONTENT_ROWS, 3)
})

test("prompt inset is responsive but bounded", () => {
  assert.equal(promptChromeInset(40), 1)
  assert.equal(promptChromeInset(120), 1)
  assert.equal(promptChromeInset(240), 1)
})
