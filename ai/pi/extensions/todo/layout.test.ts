import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"
import { chromeInset } from "../shared/chrome.ts"

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
  for (const width of [79, 80, 81, 119, 120, 121, 179, 180, 181]) {
    const active = frameTaskHud(activeTasks, width)
    const idle = frameTaskHud(idleTasks, width)

    assert.equal(active.length, 2)
    assert.equal(idle.length, 2)
    assert.equal(
      [...active, ...idle].every((line) => visibleWidth(line) === width),
      true,
    )
    assert.match(active.at(-1)?.trim() ?? "", /^│.*│$/)
    assert.doesNotMatch(active.join("\n"), /╰/)
  }

  assert.equal(PROMPT_MIN_CONTENT_ROWS, 3)
  assert.match(
    activityStatus,
    /const READY_LABEL = "READY · awaiting activity"/,
  )
  assert.match(activityStatus, /QUESTION_PENDING_COUNT_EVENT/)
  assert.match(activityStatus, /alignChromeLine\(label, width\)/)
  assert.match(activityStatus, /setProgressWidget\(questionLabel\(\), ctx\)/)
  assert.doesNotMatch(todoExtension, /borderMuted", footer\),\s*""/)
  assert.match(todoExtension, /private colorTaskHeadline/)
  assert.match(todoExtension, /private colorTaskRow/)
  assert.match(todoExtension, /\[▰▱\]\{8\}/)
  assert.match(
    todoExtension,
    /theme\.fg\("accent", line\.slice\(firstBorder \+ 1, lastBorder\)\)/,
  )
  assert.match(
    todoExtension,
    /theme\.fg\("borderAccent", line\.slice\(lastBorder\)\)/,
  )
})

test("prompt and task preview share frame edges at every supported pane width", () => {
  for (const width of [79, 80, 81, 119, 120, 121, 179, 180, 181]) {
    const promptInset = promptChromeInset(width)
    const taskInset = taskHudInset(width)
    const promptWidth = width - promptInset * 2
    const taskWidth = width - taskInset * 2

    assert.equal(promptInset, taskInset)
    assert.equal(promptInset + 1, chromeInset(width))
    assert.equal(promptWidth, taskWidth)
    assert.equal(visibleWidth(promptChromeTopLine(promptWidth)), promptWidth)
    assert.equal(frameTaskHud(activeTasks, width)[0]?.indexOf("╭"), taskInset)
  }
})
