import assert from "node:assert/strict"
import test from "node:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui"
import { Either } from "effect"
import { ManagerChatPanel } from "./manager-chat.ts"
import type { ManagerChatOptions } from "./manager-chat.ts"

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))

const fixture = (submit: ManagerChatOptions["submit"]) => {
  let closes = 0
  let renders = 0
  const scope = new AbortController()
  const terminal = {
    rows: 40,
    columns: 100,
    write: () => {},
    start: () => {},
    stop: () => {},
    hideCursor: () => {},
    showCursor: () => {},
  } as unknown as Terminal
  const tui = new TuiAltScreen(terminal)
  tui.requestRender = () => {
    renders += 1
  }
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme
  const panel = new ManagerChatPanel(tui, theme, {
    turns: [{ question: "Earlier question", answer: "Earlier answer" }],
    submit,
    signal: scope.signal,
    close: () => {
      closes += 1
      tui.stop()
    },
  })
  panel.focused = true
  tui.setLayoutRoot(panel)
  tui.start()

  const type = (text: string) => {
    for (const character of text) panel.handleInput(character)
  }
  const send = (text: string) => {
    type(text)
    panel.handleInput("\r")
  }

  return {
    panel,
    scope,
    send,
    type,
    text: () => {
      tui.renderNow()
      return tui.getScreenLines().join("\n")
    },
    closes: () => closes,
    renders: () => renders,
  }
}

test("one mounted manager panel accepts multiple chat messages and retains the transcript", async () => {
  const questions: string[] = []
  const f = fixture(async question => {
    questions.push(question)
    return Either.right(`Answer to ${question}`)
  })

  f.send("First question")
  await nextTick()
  f.send("Second question")
  await nextTick()

  assert.deepEqual(questions, ["First question", "Second question"])
  assert.ok(f.text().includes("Earlier answer"), f.text())
  assert.ok(f.text().includes("Answer to First question"))
  assert.ok(f.text().includes("Answer to Second question"))
  assert.equal(f.closes(), 0)
  f.panel.dispose()
})

test("draft follow-up remains in the composer while the manager is replying", async () => {
  let settle: ((answer: Either.Either<string, never>) => void) | undefined
  let calls = 0
  const f = fixture(async () => {
    calls += 1
    return new Promise(resolve => {
      settle = resolve
    })
  })

  f.send("First question")
  f.send("Follow-up draft")

  assert.equal(calls, 1)
  assert.ok(f.text().includes("Follow-up draft"))
  settle?.(Either.right("First answer"))
  await nextTick()
  assert.ok(f.text().includes("Follow-up draft"))
  f.panel.dispose()
})

test("closing cancels only the panel request, finishes once and ignores late replies", async () => {
  let signal: AbortSignal | undefined
  let settle: ((answer: Either.Either<string, never>) => void) | undefined
  const f = fixture(async (_question, ownedSignal) => {
    signal = ownedSignal
    return new Promise(resolve => {
      settle = resolve
    })
  })

  f.send("Question")
  f.panel.handleInput("\u001b")
  f.panel.dispose()
  assert.equal(signal?.aborted, true)
  assert.equal(f.closes(), 1)

  const renders = f.renders()
  settle?.(Either.right("Late reply"))
  await nextTick()
  assert.equal(f.renders(), renders)
})

test("scope cancellation closes an idle manager panel exactly once", () => {
  const f = fixture(async () => Either.right("Answer"))
  f.scope.abort()
  assert.equal(f.closes(), 1)
  f.panel.dispose()
  assert.equal(f.closes(), 1)
})
