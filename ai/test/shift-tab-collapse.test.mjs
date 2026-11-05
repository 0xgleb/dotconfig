import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { KeybindingsManager } from "/nix/store/nxskv7qzx13yi7a6q1fwwqiykhmjgjib-pi-coding-agent-1.3.0/lib/node_modules/pi-monorepo/dist/core/keybindings.js"
import { VimEditor } from "../pi/extensions/pi-vim/vim-editor.ts"

const managedAgentDir = fileURLToPath(new URL("../pi/", import.meta.url))

for (const mode of ["insert", "normal", "visual", "visual-line", "replace"]) {
  for (const sequence of ["\x1b[Z", "\x1b[9;2u"]) {
    test(`Shift+Tab toggles tool output without changing draft or thinking in ${mode} (${JSON.stringify(sequence)})`, () => {
      const keys = KeybindingsManager.create(managedAgentDir)
      const editor = new VimEditor(
        {
          terminal: { rows: 40, columns: 100, write: () => {} },
          requestRender: () => {},
          setShowHardwareCursor: () => {},
        },
        { borderColor: text => text, selectList: {} },
        keys,
      )
      editor.setText("draft stays intact")
      editor.vimState.mode = mode
      const cursor = editor.getCursor()
      let expanded = true
      let thinkingCycles = 0
      // Same order as Pi's interactive action registration: cycle used to win.
      editor.onAction("app.thinking.cycle", () => thinkingCycles++)
      editor.onAction("app.tools.expand", () => {
        expanded = !expanded
      })

      editor.handleInput(sequence)
      assert.equal(expanded, false)
      editor.handleInput(sequence)
      assert.equal(expanded, true)
      editor.handleInput("\x0f")
      assert.equal(expanded, false, "Ctrl+O still toggles output")
      assert.equal(thinkingCycles, 0)
      assert.equal(editor.getText(), "draft stays intact")
      assert.deepEqual(editor.getCursor(), cursor)
      assert.equal(editor.vimState.mode, mode)
      assert.equal(keys.matches("\x14", "app.thinking.toggle"), true)
    })
  }
}

test("Home Manager links the tracked keybindings into Pi's agent directory", () => {
  const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
  assert.match(
    home,
    /"\.pi\/agent\/keybindings\.json"\.source\s*=\s*config\.lib\.file\.mkOutOfStoreSymlink "\$\{aiDir\}\/pi\/keybindings\.json"/,
  )
})
