import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const editor = readFileSync(
  new URL("../pi/extensions/pi-vim/vim-editor.ts", import.meta.url),
  "utf8",
)

test("Pi Vim renders the prompt inside a pane-local inset rounded frame", () => {
  assert.match(editor, /const inset = promptChromeInset\(width\)/)
  assert.match(editor, /super\.render\(contentWidth\)/)
  assert.match(editor, /this\.borderColor\("│"\).*content.*this\.borderColor\("│"\)/s)
  assert.match(editor, /leftMargin.*line.*rightMargin/s)
})
