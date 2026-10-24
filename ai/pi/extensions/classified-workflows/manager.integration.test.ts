import assert from "node:assert/strict"
import test from "node:test"
import {
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent"
import {
  Editor,
  TuiAltScreen,
  type OverlayOptions,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui"
import { Either } from "effect"
import { ManagerChatPanel, openManagerChat } from "./manager-chat.ts"
import { MANAGER_CHAT_ENTRY } from "./manager-core.ts"
import { registerWorkManager, type ManagerModel } from "./manager.ts"
import { createOwnerAllowance } from "./owner-allowance.ts"

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve))

const fixture = (model: ManagerModel) => {
  const terminal = {
    rows: 50,
    columns: 100,
    write: () => {},
    start: () => {},
    stop: () => {},
    hideCursor: () => {},
    showCursor: () => {},
  } as unknown as Terminal
  const tui = new TuiAltScreen(terminal)
  let renders = 0
  tui.requestRender = () => {
    renders += 1
  }
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme
  const workerEditor = new Editor(tui, {
    borderColor: text => text,
    selectList: getSelectListTheme(),
  })
  workerEditor.setText("Existing worker draft")
  tui.setLayoutRoot(workerEditor)
  tui.setFocus(workerEditor)
  tui.start()

  const entries: Record<string, unknown>[] = [
    {
      id: "initial",
      type: "custom",
      customType: "todo.state",
      data: {
        todos: [{ id: 1, text: "Worker task", status: "in_progress" }],
        nextId: 2,
      },
    },
  ]
  let entryId = 0
  let customCalls = 0
  let closes = 0
  let panel: ManagerChatPanel | undefined
  const hooks = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >()
  let command:
    ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on: (
      name: string,
      callback: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => hooks.set(name, [...(hooks.get(name) ?? []), callback]),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({
        id: `entry-${++entryId}`,
        type: "custom",
        customType,
        data,
      }),
    registerEntryRenderer: () => {},
    registerCommand: (
      _name: string,
      registration: { handler: typeof command },
    ) => {
      command = registration.handler
    },
    sendUserMessage: () => assert.fail("manager started a worker turn"),
    sendMessage: () => assert.fail("manager queued a worker continuation"),
  } as unknown as ExtensionAPI
  const ctx = {
    mode: "tui",
    isIdle: () => false,
    model: { id: "test", provider: "openai-codex" },
    sessionManager: {
      getSessionId: () => "integration-session",
      getBranch: () => entries,
    },
    ui: {
      notify: () => {},
      setWidget: () => {},
      input: () => assert.fail("manager opened a one-off input dialog"),
      custom: (
        factory: (
          tui: TUI,
          theme: Theme,
          keys: unknown,
          done: () => void,
        ) => ManagerChatPanel,
        options: { overlayOptions?: OverlayOptions },
      ) =>
        new Promise<void>(resolve => {
          customCalls += 1
          let finished = false
          const done = () => {
            if (finished) return
            finished = true
            closes += 1
            tui.hideOverlay()
            resolve()
          }
          panel = factory(tui, theme, undefined, done)
          assert.ok(panel instanceof ManagerChatPanel)
          tui.showOverlay(panel, options.overlayOptions)
        }),
    },
  } as unknown as ExtensionContext
  const guard = createOwnerAllowance({
    now: () => 1000,
    schedule: () => 0,
    clear: () => {},
    persist: () => {},
    cancel: () => {},
  })
  guard.ownerInput(1000)
  registerWorkManager(pi, guard, model, openManagerChat)

  const emit = async (name: string) => {
    for (const callback of hooks.get(name) ?? []) await callback({}, ctx)
  }
  const open = () => {
    assert.ok(command)
    return command("", ctx)
  }
  const send = (text: string) => {
    assert.ok(panel)
    for (const character of text) panel.handleInput(character)
    panel.handleInput("\r")
  }
  const close = () => {
    panel?.handleInput("\u001b")
  }
  const screen = () => {
    tui.renderNow()
    return tui.getScreenLines().join("\n")
  }

  return {
    entries,
    workerEditor,
    emit,
    open,
    send,
    close,
    screen,
    customCalls: () => customCalls,
    closes: () => closes,
    renders: () => renders,
    cleanup: () => {
      panel?.dispose()
      tui.stop()
      guard.dispose()
    },
  }
}

test("legacy injected view remains callable and carries prior conversation turns", async t => {
  const requests: { history: unknown[]; question: string }[] = []
  const f = fixture(async (_ctx, request) => {
    requests.push(JSON.parse(request.body))
    return Either.right(`Manager reply ${requests.length}`)
  })
  t.after(f.cleanup)
  await f.emit("session_start")
  const running = f.open()
  await nextTick()

  f.send("First question")
  await nextTick()
  f.send("Second question")
  await nextTick()

  assert.equal(f.customCalls(), 1)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1]?.history, [
    { question: "First question", answer: "Manager reply 1" },
  ])
  assert.ok(f.screen().includes("Manager reply 1"), f.screen())
  assert.ok(f.screen().includes("Manager reply 2"))
  assert.equal(f.workerEditor.getText(), "Existing worker draft")

  f.close()
  await running
  assert.equal(f.closes(), 1)
  assert.equal(f.workerEditor.focused, true)
})

test("session-tree replacement closes an active real overlay and prevents stale persistence", async t => {
  let signal: AbortSignal | undefined
  let settle: ((value: Either.Either<string, never>) => void) | undefined
  const f = fixture(async (_ctx, request) => {
    signal = request.signal
    return new Promise(resolve => {
      settle = resolve
    })
  })
  t.after(f.cleanup)
  await f.emit("session_start")
  const running = f.open()
  await nextTick()
  f.send("Question in flight")
  await nextTick()

  await f.emit("session_tree")
  await running
  assert.equal(signal?.aborted, true)
  assert.equal(f.closes(), 1)
  assert.equal(f.workerEditor.focused, true)
  assert.equal(f.workerEditor.getText(), "Existing worker draft")

  const renders = f.renders()
  settle?.(Either.right("Stale result"))
  await nextTick()
  assert.equal(f.renders(), renders)
  assert.equal(
    f.entries.some(entry => entry.customType === MANAGER_CHAT_ENTRY),
    false,
  )
})
