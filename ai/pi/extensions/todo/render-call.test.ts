import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const theme = {
  fg: (_kind: string, text: string) => text,
  bold: (text: string) => text,
}

const loadTool = async (): Promise<{
  renderCall: (args: never, theme: typeof theme) => { readonly text: string }
}> => {
  const support: unknown = await import(
    new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
  )

  assert.ok(record(support) && typeof support.loadHostExtension === "function")

  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )

  assert.ok(typeof factory === "function")

  let tool: unknown
  factory({
    events: { on: () => {} },
    registerTool: (definition: unknown) => {
      tool = definition
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    on: () => () => {},
    setWidget: () => {},
  })

  assert.ok(
    record(tool) && typeof tool.renderCall === "function",
    "actual Jiti-loaded todo extension exposes renderCall",
  )

  return tool as {
    renderCall: (args: never, theme: typeof theme) => { readonly text: string }
  }
}

test("priority_relative renders the moved task, direction and reference", async () => {
  const tool = await loadTool()
  const rendered = tool.renderCall(
    { action: "priority_relative", id: 7, referenceId: 3, position: "above" } as never,
    theme,
  )

  assert.match(rendered.text, /#7 above #3/)
})

test("priority_order renders the ordered id sequence", async () => {
  const tool = await loadTool()
  const rendered = tool.renderCall(
    { action: "priority_order", ids: [4, 9, 2] } as never,
    theme,
  )

  assert.match(rendered.text, /#4 #9 #2/)
})
