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

test("prompt stays single-row when empty to preserve screen space", () => {
  assert.equal(PROMPT_MIN_CONTENT_ROWS, 1)
})

test("prompt frame compensates for the host editor's built-in pane padding", () => {
  assert.equal(promptChromeInset(40), 0)
  assert.equal(promptChromeInset(120), 0)
  assert.equal(promptChromeInset(240), 0)
})
