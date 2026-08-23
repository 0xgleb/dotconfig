import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import {
  HUD_ANIMATION_INTERVAL_MS,
  HUD_IDLE_ANIMATION_INTERVAL_MS,
  synchronizedTaskHudFrame,
  TaskHudComponent,
} from "./task-hud.ts"
import { KANBAN_OVERLAY_OPTIONS, KanbanComponent } from "./kanban.ts"
import type { TodoState } from "./state.ts"

const todoExtensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)
const taskHudSource = readFileSync(
  new URL("./task-hud.ts", import.meta.url),
  "utf8",
)

const state: TodoState = {
  nextId: 6,
  todos: [
    { id: 1, text: "Finished", status: "completed" },
    { id: 2, text: "Working", status: "in_progress" },
    { id: 3, text: "Queued", status: "pending" },
    { id: 4, text: "Blocked", status: "blocked", reason: "Waiting" },
    { id: 5, text: "Awaiting review", status: "in_review" },
  ],
}

test("kanban overlay is centered within the current Pi pane", () => {
  assert.deepEqual(KANBAN_OVERLAY_OPTIONS, {
    anchor: "center",
    width: "72%",
    minWidth: 64,
    maxHeight: "80%",
    margin: 2,
  })
})

test("kanban renders a glass-backed frame in project-status order", () => {
  let backgroundCalls = 0
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => {
      backgroundCalls += 1
      return text
    },
    bold: (text: string) => text,
  } as unknown as Theme
  const lines = new KanbanComponent(state, theme, () => {}).render(90)
  const headings = lines.find(
    line =>
      line.includes("TODO") &&
      line.includes("IN PROGRESS") &&
      line.includes("IN REVIEW") &&
      line.includes("DONE"),
  )

  assert.ok(headings)
  assert.ok(headings.indexOf("TODO") < headings.indexOf("IN PROGRESS"))
  assert.ok(headings.indexOf("IN PROGRESS") < headings.indexOf("IN REVIEW"))
  assert.ok(headings.indexOf("IN REVIEW") < headings.indexOf("DONE"))
  assert.match(lines[0] ?? "", /^╭.*KANBAN.*20% done.*╮$/)
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/)
  assert.ok(backgroundCalls >= lines.length - 2)
  for (const line of lines) assert.equal(visibleWidth(line), 90)
})

test("kanban supports Vim navigation and wrapped task details", () => {
  let changes = 0
  let closed = false
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme
  const component = new KanbanComponent(
    state,
    theme,
    () => {
      closed = true
    },
    () => {
      changes += 1
    },
  )

  assert.match(component.render(90).join("\n"), /› \[ \] #3 Queued/)
  component.handleInput("G")
  component.handleInput("\r")
  const blockedDetail = component.render(90).join("\n")
  assert.match(blockedDetail, /KANBAN DETAIL/)
  assert.match(blockedDetail, /#4 · blocked/)
  assert.match(blockedDetail, /Blocked:/)
  assert.match(blockedDetail, /Waiting/)

  component.handleInput("\x1b")
  assert.match(component.render(90).join("\n"), /TODO.*IN PROGRESS/)
  component.handleInput("l")
  component.handleInput(" ")
  assert.match(component.render(90).join("\n"), /#2 · in progress/)
  component.handleInput("\x1b")
  component.handleInput("\x1b")

  assert.equal(closed, true)
  assert.ok(changes >= 5)
})

test("kanban unblocks the selected blocked task directly", async () => {
  let unblockedId: number | undefined
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme
  const component = new KanbanComponent(
    state,
    theme,
    () => {},
    () => {},
    async todo => {
      unblockedId = todo.id
      return {
        ...state,
        todos: state.todos.map(candidate =>
          candidate.id === todo.id
            ? {
                id: candidate.id,
                text: candidate.text,
                status: "pending" as const,
              }
            : candidate,
        ),
      }
    },
  )

  component.handleInput("G")
  assert.match(component.render(90).join("\n"), /u unblock/)
  component.handleInput("u")
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(unblockedId, 4)
  assert.match(component.render(90).join("\n"), /\[ \] #4 Blocked/)
})

test("active animation ticks faster while idle keeps its slower cadence", () => {
  assert.equal(HUD_ANIMATION_INTERVAL_MS, 300)
  assert.equal(HUD_IDLE_ANIMATION_INTERVAL_MS, 500)
  assert.ok(HUD_ANIMATION_INTERVAL_MS < HUD_IDLE_ANIMATION_INTERVAL_MS)
})

test("task HUD phase is synchronized by wall clock across panes", () => {
  assert.equal(synchronizedTaskHudFrame(0, 500), 0)
  assert.equal(synchronizedTaskHudFrame(999, 500), 1)
  assert.equal(synchronizedTaskHudFrame(1_000, 500), 2)
  assert.equal(synchronizedTaskHudFrame(1_499, 500), 2)
  assert.throws(() => synchronizedTaskHudFrame(-1, 500), /timestamp/i)
  assert.throws(() => synchronizedTaskHudFrame(1_000, 0), /interval/i)
})

test("task HUD does not request renders on a background timer", async () => {
  const theme = {
    fg: (color: string, text: string) =>
      color === "accent"
        ? `\x1b[38;2;100;120;140m${text}\x1b[39m`
        : `\x1b[38;2;80;80;80m${text}\x1b[39m`,
    bold: (text: string) => `<bold>${text}</bold>`,
  } as unknown as Theme
  let renderRequests = 0
  const component = new TaskHudComponent(
    state,
    theme,
    () => {
      renderRequests += 1
    },
    { intervalMs: 5 },
  )

  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(renderRequests, 0)
  component.dispose()
})

test("active progress positively pulses filled cells while idle owns off glyphs", () => {
  const renderer = taskHudSource.slice(
    taskHudSource.indexOf("private colorTaskHeadline"),
    taskHudSource.indexOf("private colorTaskRow"),
  )
  assert.doesNotMatch(
    renderer,
    /"success"|SLOW_BLINK|RAPID_BLINK|dimText|" "|▏|▎|▍|▌|▋|▊|▉|!this\.idle && !pulseOn/,
  )
  assert.match(
    renderer,
    /const completedCellCount =\s*cells\.findLastIndex\([\s\S]*?candidate => candidate !== "▱",?[\s\S]*?\) \+ 1/,
  )
  assert.match(renderer, /taskProgressDisplayedCell/)
  assert.match(renderer, /taskProgressCellPulse/)
  assert.match(renderer, /displayedCell === "▱" \? "muted" : "accent"/)
  assert.match(renderer, /if \(!pulseOn\) return hued/)
  assert.match(renderer, /brightenTruecolorForeground\(hued\) \?\? hued/)
})

test("task progress animation never owns TUI invalidation", () => {
  assert.match(taskHudSource, /HUD_ANIMATION_INTERVAL_MS = 300/)
  assert.match(taskHudSource, /HUD_IDLE_ANIMATION_INTERVAL_MS = 500/)
  assert.match(
    taskHudSource,
    /options\.idle[\s\S]*?HUD_IDLE_ANIMATION_INTERVAL_MS[\s\S]*?HUD_ANIMATION_INTERVAL_MS/,
  )
  assert.doesNotMatch(taskHudSource, /setInterval/)
  assert.match(taskHudSource, /synchronizedTaskHudFrame\([\s\S]*?Date\.now\(\)/)
  assert.match(todoExtensionSource, /idle: ctx\.isIdle\(\)/)
  assert.match(
    todoExtensionSource,
    /pi\.on\("agent_start"[\s\S]*?renderTaskWidget/,
  )
  assert.match(
    todoExtensionSource,
    /pi\.on\("agent_settled"[\s\S]*?renderTaskWidget/,
  )
  assert.match(todoExtensionSource, /tui\.requestRender\(\)/)
  assert.doesNotMatch(todoExtensionSource, /hudAnimation|agentRunning/)
})

test("the task HUD widget mounts only when shouldShowTaskHud allows it", () => {
  assert.match(
    todoExtensionSource,
    /ctx\.ui\.setWidget\(\s*"todo-top-tasks",\s*shouldShowTaskHud\(summary, hudVisibility\)/,
  )
})

test("ctrl+t toggles task HUD visibility through the global terminal input hook", () => {
  assert.match(todoExtensionSource, /ctx\.ui\.onTerminalInput\(/)
  assert.match(todoExtensionSource, /matchesKey\(data, "ctrl\+t"\)/)
  assert.match(
    todoExtensionSource,
    /hudVisibility = toggleTaskHudVisibility\(hudVisibility\)/,
  )
})

test("the terminal input hook is released on session shutdown", () => {
  const shutdown = todoExtensionSource.slice(
    todoExtensionSource.indexOf('pi.on("session_shutdown"'),
    todoExtensionSource.indexOf('pi.on("session_shutdown"') + 400,
  )
  assert.match(shutdown, /releaseHudToggle\?\.\(\)/)
  assert.match(shutdown, /releaseHudToggle = undefined/)
})

test("todo state and reminders never trigger model turns", () => {
  assert.doesNotMatch(todoExtensionSource, /triggerTurn:\s*true/)
  assert.doesNotMatch(todoExtensionSource, /deliverAs:\s*["']followUp["']/)
  assert.doesNotMatch(todoExtensionSource, /pi\.sendUserMessage\(/)
})

test("kanban reapplies its glass background after nested foreground resets", () => {
  const backgroundPrefix = "\x1b[48;2;24;20;58m"
  const backgroundSuffix = "\x1b[49m"
  const theme = {
    fg: (_color: string, text: string) =>
      `\x1b[38;2;232;246;255m${text}\x1b[0m`,
    bg: (_color: string, text: string) =>
      `${backgroundPrefix}${text}${backgroundSuffix}`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  } as unknown as Theme
  const lines = new KanbanComponent(state, theme, () => {}).render(90)

  for (const line of lines.slice(1, -1)) {
    const backgroundStart = line.indexOf(backgroundPrefix)
    const backgroundEnd = line.lastIndexOf(backgroundSuffix)
    assert.ok(
      backgroundStart >= 0,
      "every interior row starts the glass background",
    )
    assert.ok(
      backgroundEnd > backgroundStart,
      "every interior row closes the glass background",
    )
    const interior = line.slice(
      backgroundStart + backgroundPrefix.length,
      backgroundEnd,
    )
    assert.doesNotMatch(interior, /\x1b\[0m(?!\x1b\[48;2;24;20;58m)/)
    assert.equal(visibleWidth(line), 90)
  }
})
