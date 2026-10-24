import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { stableVimMode } from "../state.ts"

const extensionSource = readFileSync(
  new URL("../index.ts", import.meta.url),
  "utf8",
)
const editorSource = readFileSync(
  new URL("../vim-editor.ts", import.meta.url),
  "utf8",
)

test("reload persistence restores only stable insert or normal state", () => {
  assert.equal(stableVimMode("insert"), "insert")
  assert.equal(stableVimMode("normal"), "normal")
  assert.equal(stableVimMode("replace"), "normal")
  assert.equal(stableVimMode("visual"), "normal")
  assert.equal(stableVimMode("visual-line"), "normal")
  assert.equal(stableVimMode("command-line"), "normal")
  assert.equal(stableVimMode("operator-pending"), "normal")
})

test("pi-vim snapshots mode once at shutdown and restores it when the editor is recreated", () => {
  assert.match(extensionSource, /VIM_MODE_ENTRY = "pi-vim\.mode"/)
  assert.match(
    extensionSource,
    /restoreVimMode\(ctx\.sessionManager\.getBranch\(\)\)/,
  )
  assert.match(extensionSource, /initialMode: restoredMode/)
  assert.match(extensionSource, /pi\.on\("session_shutdown"/)
  assert.match(
    extensionSource,
    /pi\.appendEntry\(VIM_MODE_ENTRY, \{[\s\S]*?mode: stableVimMode\(activeEditor\.vimState\.mode\),?[\s\S]*?\}\)/,
  )
  assert.doesNotMatch(extensionSource, /onModeChange/)
  assert.match(
    editorSource,
    /this\.vimState\.mode = steering\?\.initialMode \?\? "insert"/,
  )
  assert.doesNotMatch(editorSource, /onModeChange/)
})
