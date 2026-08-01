import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"

import {
  PROMPT_MIN_CONTENT_ROWS,
  promptChromeInset,
  promptChromeTopLine,
} from "../pi-vim/chrome.ts"
import { frameTaskHud, taskHud, taskHudInset } from "./presentation.ts"

const activityStatus = readFileSync(
  new URL("../activity-status/index.ts", import.meta.url),
  "utf8",
)
const todoExtension = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const activeTasks = taskHud({
  nextId: 3,
  todos: [
    { id: 1, text: "Implement", status: "in_progress" },
    { id: 2, text: "Review", status: "in_review" },
  ],
})

const idleTasks = taskHud({ nextId: 1, todos: [] })

test("side-by-side sessions reserve identical fixed-height chrome", () => {
  for (const width of [80, 120, 180]) {
    const active = frameTaskHud(activeTasks, width)
    const idle = frameTaskHud(idleTasks, width)

    assert.equal(active.length, 3)
    assert.equal(idle.length, 3)
    assert.equal(
      [...active, ...idle].every((line) => visibleWidth(line) === width),
      true,
    )
  }

  assert.equal(PROMPT_MIN_CONTENT_ROWS, 3)
  assert.match(
    activityStatus,
    /const IDLE_PROGRESS_ROW = \["READY · awaiting activity"\] as const/,
  )
  assert.match(
    activityStatus,
    /setWidget\(TOOL_PROGRESS_WIDGET_KEY, IDLE_PROGRESS_ROW,[\s\S]*?placement: "belowEditor"/,
  )
  assert.doesNotMatch(todoExtension, /borderMuted", footer\),\s*""/)
})

test("prompt is wider than the task preview at every supported pane width", () => {
  for (const width of [80, 120, 180]) {
    const promptInset = promptChromeInset(width)
    const taskInset = taskHudInset(width)
    const promptWidth = width - promptInset * 2
    const taskWidth = width - taskInset * 2

    assert.ok(promptInset < taskInset)
    assert.ok(promptWidth > taskWidth)
    assert.equal(visibleWidth(promptChromeTopLine(promptWidth)), promptWidth)
    assert.equal(frameTaskHud(activeTasks, width)[0]?.indexOf("╭"), taskInset)
  }
})
