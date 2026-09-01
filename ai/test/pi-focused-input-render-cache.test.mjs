import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

const packageRoot = process.argv[2]
assert.ok(packageRoot, "pass the patched @earendil-works/pi-tui package root")

const { TuiMainScreen } = await import(
  pathToFileURL(`${packageRoot}/dist/tui-main-screen.js`).href
)
const { Container } = await import(
  pathToFileURL(`${packageRoot}/dist/tui.js`).href
)

class FakeTerminal {
  columns = 120
  rows = 40
  writes = []
  write(value) {
    this.writes.push(value)
  }
  hideCursor() {}
  showCursor() {}
  start() {}
  stop() {}
}

let transcriptRenders = 0
const transcript = {
  invalidate() {},
  render() {
    transcriptRenders += 1
    return Array.from({ length: 20_000 }, (_, index) => `history ${index}`)
  },
}

let editorRenders = 0
let editorText = ""
const editor = {
  focused: false,
  invalidate() {},
  handleInput(data) {
    editorText += data
  },
  render() {
    editorRenders += 1
    return [`prompt ${editorText}`]
  },
}

const transcriptRoot = new Container()
transcriptRoot.addChild(transcript)
const editorRoot = new Container()
editorRoot.addChild(editor)

const hugeTranscriptRoot = new Container()
hugeTranscriptRoot.addChild({
  invalidate() {},
  render() {
    return Array.from({ length: 200_000 }, (_, index) => `history ${index}`)
  },
})
const hugeTranscriptTui = new TuiMainScreen(new FakeTerminal())
hugeTranscriptTui.addChild(hugeTranscriptRoot)
assert.doesNotThrow(
  () => hugeTranscriptTui.renderRootChildren(120, undefined),
  "combining a large transcript must not exceed the JavaScript argument stack",
)

const cyclicRoot = new Container()
cyclicRoot.addChild(cyclicRoot)
assert.equal(
  hugeTranscriptTui.rootContains(cyclicRoot, editor),
  false,
  "focused-root discovery must terminate on cyclic component graphs",
)

const failingTerminal = new FakeTerminal()
const failingRoot = {
  invalidate() {},
  render() {
    throw new Error("component render failed")
  },
}
const failingTui = new TuiMainScreen(failingTerminal)
failingTui.addChild(failingRoot)
assert.doesNotThrow(
  () => failingTui.renderNow(),
  "a synchronous component render failure must not escape the TUI scheduler",
)
assert.match(
  failingTerminal.writes.join(""),
  /Pi render error contained: Error: component render failed/u,
)

const asyncFailingTerminal = new FakeTerminal()
let resolveAsyncRender
const asyncRenderWritten = new Promise(resolve => {
  resolveAsyncRender = resolve
})
asyncFailingTerminal.write = value => {
  asyncFailingTerminal.writes.push(value)
  resolveAsyncRender()
}
const asyncFailingTui = new TuiMainScreen(asyncFailingTerminal)
asyncFailingTui.addChild(failingRoot)
asyncFailingTui.requestRender()
await asyncRenderWritten
assert.match(
  asyncFailingTerminal.writes.join(""),
  /Pi render error contained: Error: component render failed/u,
  "a timer-driven component render failure must be contained",
)

const brokenDiagnosticTerminal = new FakeTerminal()
brokenDiagnosticTerminal.write = () => {
  throw new Error("terminal write failed")
}
const brokenDiagnosticTui = new TuiMainScreen(brokenDiagnosticTerminal)
brokenDiagnosticTui.addChild(failingRoot)
assert.doesNotThrow(
  () => brokenDiagnosticTui.renderNow(),
  "a failed render diagnostic sink must not escape containment",
)

failingTui.removeChild(failingRoot)
failingTui.addChild({
  invalidate() {},
  render() {
    return ["recovered"]
  },
})
assert.doesNotThrow(
  () => failingTui.renderNow(),
  "the TUI must remain renderable after a contained failure",
)

const tui = new TuiMainScreen(new FakeTerminal())
tui.addChild(transcriptRoot)
tui.addChild(editorRoot)
tui.setFocus(editor)
tui.renderNow()
assert.equal(transcriptRenders, 1)
assert.equal(editorRenders, 1)

// Call the compiled input boundary directly. Its immediate render is queued on
// nextTick, exactly as it is for a real terminal key event.
tui.handleTerminalInput("x")
await new Promise(resolve => setImmediate(resolve))
assert.equal(editorText, "x")
assert.equal(editorRenders, 2)
assert.equal(
  transcriptRenders,
  1,
  "focused typing must not rebuild the 20k-line transcript root",
)

// A non-input render request invalidates the focused-only proof and must render
// every root so background/status/session mutations cannot remain stale.
tui.requestRender()
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal(transcriptRenders, 2)
assert.equal(editorRenders, 3)

// A terminal-input listener may mutate another root before the editor receives
// the same key. That invalidates the focused-only proof for this frame.
tui.addInputListener(data => {
  if (data === "y") tui.requestRender()
  return { data }
})
tui.handleTerminalInput("y")
await new Promise(resolve => setImmediate(resolve))
assert.equal(editorText, "xy")
assert.equal(transcriptRenders, 3)
assert.equal(editorRenders, 4)

tui.stop({ preserveScreen: true })
console.log("focused input render cache: ok")
