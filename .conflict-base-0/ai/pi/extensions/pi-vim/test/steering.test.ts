import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  isSlashCommandInput,
  streamingSubmissionMode,
} from "../steering.ts"

const editorSource = readFileSync(
  new URL("../vim-editor.ts", import.meta.url),
  "utf8",
)
const extensionSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8")

const route = (
  text: string,
  isStreaming: boolean,
  key: "enter" | "ctrl+enter",
) =>
  streamingSubmissionMode({
    text,
    isStreaming,
    isEnter: key === "enter",
    isCtrlEnter: key === "ctrl+enter",
  })

test("ordinary Enter follows up while streaming", () => {
  assert.equal(route("also check the docs", true, "enter"), "followUp")
  assert.match(editorSource, /submissionMode === "followUp"/)
  assert.match(extensionSource, /deliverAs: "followUp"/)
})

test("Ctrl+Enter steers while streaming", () => {
  assert.equal(route("stop and inspect this", true, "ctrl+enter"), "steer")
  assert.match(editorSource, /matchesKey\(data, "ctrl\+enter"\)/)
  assert.match(
    editorSource,
    /submissionMode === "steer"[\s\S]*?this\.onSubmit\?\.\(text\)/,
  )
})

test("idle Enter uses normal immediate submission", () => {
  assert.equal(route("start the task", false, "enter"), "pass")
  assert.equal(route("start the task", false, "ctrl+enter"), "immediate")
})

test("slash commands preserve immediate host command handling", () => {
  assert.equal(isSlashCommandInput("/questions"), true)
  assert.equal(isSlashCommandInput("  /questions"), true)
  assert.equal(route("/questions", true, "enter"), "pass")
  assert.equal(route("/questions", true, "ctrl+enter"), "immediate")
})

test("empty and unrelated input do not submit", () => {
  assert.equal(route("", true, "enter"), "pass")
  assert.equal(
    streamingSubmissionMode({
      text: "draft",
      isStreaming: true,
      isEnter: false,
      isCtrlEnter: false,
    }),
    "pass",
  )
})
