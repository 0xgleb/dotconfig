import assert from "node:assert/strict"
import test from "node:test"
import { Container, type Component, type TUI } from "@earendil-works/pi-tui"
import {
  getFocusedInputLatencySnapshot,
  installFocusedInputRenderCache,
  resetFocusedInputLatencySnapshot,
} from "./focused-input-render-cache.ts"

class FakeTui extends Container {
  focusedComponent: Component | null = null
  hasOverlayEntries = false
  previousLines: string[] = []
  previousWidth = 100
  terminal = { columns: 100, write: (_data: string) => {} }
  renderRequests = 0
  canvasCalls = 0

  requestRender(): void {
    this.renderRequests += 1
  }

  applyLineResets(lines: string[]): string[] {
    return lines.map(line => `${line}\u001b[0m`)
  }

  doRender(): void {
    this.previousLines = this.applyLineResets(this.render(100)).map(line => {
      this.canvasCalls += 1
      return `${line} canvas`
    })
  }
}

test("focused editor input reuses transcript roots and external renders invalidate the proof", () => {
  const tui = new FakeTui()
  let transcriptRenders = 0
  const transcript: Component = {
    invalidate() {},
    render: () => {
      transcriptRenders += 1
      return Array.from({ length: 20_000 }, (_, index) => `history ${index}`)
    },
  }
  let editorRenders = 0
  let editorText = ""
  const editor: Component = {
    invalidate() {},
    handleInput: data => {
      editorText += data
      tui.requestRender()
    },
    render: () => {
      editorRenders += 1
      return [`prompt ${editorText}`]
    },
  }

  const transcriptRoot = new Container()
  transcriptRoot.addChild(transcript)
  const editorRoot = new Container()
  editorRoot.addChild(editor)
  tui.addChild(transcriptRoot)
  tui.addChild(editorRoot)
  tui.focusedComponent = editor

  const release = installFocusedInputRenderCache(tui as unknown as TUI, editor)

  tui.requestRender()
  tui.doRender()
  assert.equal(transcriptRenders, 1)
  assert.equal(editorRenders, 1)
  assert.equal(tui.canvasCalls, 20_001)

  editor.handleInput?.("x")
  tui.doRender()
  assert.equal(editorText, "x")
  assert.equal(editorRenders, 2)
  assert.equal(
    transcriptRenders,
    1,
    "typing must not rebuild the 20k-line transcript",
  )
  assert.equal(
    tui.canvasCalls,
    20_002,
    "typing must not redecorate the 20k-line transcript",
  )

  tui.requestRender()
  tui.doRender()
  assert.equal(transcriptRenders, 2)
  assert.equal(editorRenders, 3)
  assert.equal(tui.canvasCalls, 40_003)

  // A sibling mutation request that precedes the editor input invalidates the
  // focused-only frame, even though the editor also requests a render.
  tui.requestRender()
  editor.handleInput?.("y")
  tui.doRender()
  assert.equal(editorText, "xy")
  assert.equal(transcriptRenders, 3)
  assert.equal(editorRenders, 4)

  release()
  editor.handleInput?.("z")
  tui.doRender()
  assert.equal(transcriptRenders, 4)
})

test("focused input cache handles transcripts larger than the JavaScript argument limit", () => {
  const tui = new FakeTui()
  let transcriptRenders = 0
  const transcript: Component = {
    invalidate() {},
    render: () => {
      transcriptRenders += 1
      return Array.from({ length: 200_000 }, (_, index) => `history ${index}`)
    },
  }
  let editorText = ""
  const editor: Component = {
    invalidate() {},
    handleInput: data => {
      editorText += data
      tui.requestRender()
    },
    render: () => [`prompt ${editorText}`],
  }
  const transcriptRoot = new Container()
  transcriptRoot.addChild(transcript)
  const editorRoot = new Container()
  editorRoot.addChild(editor)
  tui.addChild(transcriptRoot)
  tui.addChild(editorRoot)
  tui.focusedComponent = editor

  const release = installFocusedInputRenderCache(tui as unknown as TUI, editor)
  tui.requestRender()
  tui.doRender()
  editor.handleInput?.("x")

  assert.doesNotThrow(() => tui.doRender())
  assert.equal(transcriptRenders, 1)
  assert.equal(tui.previousLines.length, 200_001)
  release()
})

test("native host renderer replacement cannot recurse through stale render wrappers", () => {
  resetFocusedInputLatencySnapshot()
  const first = new FakeTui() as FakeTui & {
    consumeFocusedInputRenderTarget: () => Component | undefined
  }
  first.consumeFocusedInputRenderTarget = () =>
    first.focusedComponent ?? undefined
  const second = new FakeTui() as FakeTui & {
    consumeFocusedInputRenderTarget: () => Component | undefined
  }
  second.consumeFocusedInputRenderTarget = () =>
    second.focusedComponent ?? undefined
  const active: { tui: TUI } = { tui: first as unknown as TUI }
  const reference = new Proxy({} as TUI, {
    get: (_target, property) => {
      const tui = active.tui as unknown as Record<PropertyKey, unknown>
      const value = Reflect.get(tui, property, tui)
      if (typeof value !== "function") return value
      let methodTui = tui
      let method = value
      return (...args: unknown[]) => {
        const currentTui = active.tui as unknown as Record<PropertyKey, unknown>
        if (currentTui !== methodTui) {
          const currentMethod = Reflect.get(currentTui, property, currentTui)
          assert.equal(typeof currentMethod, "function")
          methodTui = currentTui
          method = currentMethod
        }
        return Reflect.apply(
          method as (...values: unknown[]) => unknown,
          methodTui,
          args,
        )
      }
    },
    set: (_target, property, value) => {
      const tui = active.tui as unknown as Record<PropertyKey, unknown>
      return Reflect.set(tui, property, value, tui)
    },
  })
  const firstEditor: Component = {
    invalidate() {},
    handleInput: () => first.requestRender(),
    render: () => ["first"],
  }
  first.addChild(firstEditor)
  first.focusedComponent = firstEditor
  const releaseFirst = installFocusedInputRenderCache(reference, firstEditor)

  const secondEditor: Component = {
    invalidate() {},
    handleInput: () => second.requestRender(),
    render: () => ["second"],
  }
  second.addChild(secondEditor)
  second.focusedComponent = secondEditor
  active.tui = second as unknown as TUI
  releaseFirst()
  const releaseSecond = installFocusedInputRenderCache(reference, secondEditor)

  assert.doesNotThrow(() => second.doRender())
  releaseSecond()
})

test("native host caching remains unwrapped by the compatibility shim", () => {
  resetFocusedInputLatencySnapshot()
  const tui = new FakeTui() as FakeTui & {
    consumeFocusedInputRenderTarget: () => Component | undefined
  }
  tui.consumeFocusedInputRenderTarget = () => tui.focusedComponent ?? undefined
  let editorText = ""
  const editor: Component = {
    invalidate() {},
    handleInput: data => {
      editorText += data
      tui.requestRender()
    },
    render: () => [`prompt ${editorText}`],
  }
  tui.addChild(editor)
  tui.focusedComponent = editor
  const originalDoRender = tui.doRender
  const originalRequestRender = tui.requestRender
  const originalEditorInput = editor.handleInput

  const release = installFocusedInputRenderCache(tui as unknown as TUI, editor)

  assert.equal(tui.doRender, originalDoRender)
  assert.equal(tui.requestRender, originalRequestRender)
  assert.equal(editor.handleInput, originalEditorInput)
  assert.equal(getFocusedInputLatencySnapshot().samples.length, 0)
  release()
})

test("focused input observability measures the real render boundary without retaining text", async () => {
  const module =
    (await import("./focused-input-render-cache.ts")) as unknown as {
      getFocusedInputLatencySnapshot?: () => {
        readonly samples: readonly Array<{
          readonly inputBytes: number
          readonly totalMs: number
          readonly previousFrameLines: number
        }>
      }
      resetFocusedInputLatencySnapshot?: () => void
    }
  assert.equal(typeof module.getFocusedInputLatencySnapshot, "function")
  assert.equal(typeof module.resetFocusedInputLatencySnapshot, "function")
  module.resetFocusedInputLatencySnapshot?.()

  const tui = new FakeTui()
  const transcript: Component = {
    invalidate() {},
    render: () =>
      Array.from({ length: 20_000 }, (_, index) => `history ${index}`),
  }
  let editorText = ""
  const editor: Component = {
    invalidate() {},
    handleInput: data => {
      editorText += data
      tui.requestRender()
    },
    render: () => [`prompt ${editorText}`],
  }
  const transcriptRoot = new Container()
  transcriptRoot.addChild(transcript)
  const editorRoot = new Container()
  editorRoot.addChild(editor)
  tui.addChild(transcriptRoot)
  tui.addChild(editorRoot)
  tui.focusedComponent = editor

  const release = installFocusedInputRenderCache(tui as unknown as TUI, editor)
  tui.requestRender()
  tui.doRender()
  editor.handleInput?.("x")
  tui.doRender()

  const snapshot = module.getFocusedInputLatencySnapshot?.()
  assert.ok(snapshot)
  assert.equal(snapshot.samples.length, 1)
  assert.equal(snapshot.samples[0]?.inputBytes, 1)
  assert.equal(snapshot.samples[0]?.previousFrameLines, 20_001)
  assert.ok((snapshot.samples[0]?.totalMs ?? -1) >= 0)
  assert.doesNotMatch(JSON.stringify(snapshot), /prompt x|history 1/)

  release()
})
