import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"
import type {
  ExtensionAPI,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { TodoRequest } from "./state.ts"

type CallRenderer = NonNullable<ToolDefinition["renderCall"]>

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const theme = {
  fg: (_kind: string, text: string) => text,
  bold: (text: string) => text,
} satisfies Pick<Theme, "fg" | "bold">

const loadRenderer = async (): Promise<CallRenderer> => {
  const support: unknown = await import(
    new URL("../../../test/pi-host-test-support.mjs", import.meta.url).href
  )

  assert.ok(record(support) && typeof support.loadHostExtension === "function")

  const factory: unknown = await support.loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )

  assert.ok(typeof factory === "function")

  let renderCall: CallRenderer | undefined
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    registerTool: definition => {
      // The test host erases schema/state generics; calls below use TodoRequest.
      renderCall = definition.renderCall as CallRenderer | undefined
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    on: () => () => {},
  } satisfies Pick<
    ExtensionAPI,
    "events" | "registerTool" | "registerCommand" | "registerShortcut" | "on"
  >
  const partialHost: Partial<ExtensionAPI> = pi

  // Registration uses only the SDK-checked host methods above.
  factory(partialHost as ExtensionAPI)

  assert.ok(renderCall, "actual Jiti-loaded todo extension exposes renderCall")

  return renderCall
}

const render = async (args: TodoRequest): Promise<string> => {
  const renderCall = await loadRenderer()
  const hostOptions = { durationMs: undefined, outputPad: 0 }
  const context = {
    args,
    toolCallId: "todo-render-call",
    invalidate: () => {},
    lastComponent: undefined,
    state: undefined,
    cwd: "/projects/todo-render-fixture",
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...hostOptions,
  } satisfies Parameters<CallRenderer>[2]

  // The renderer uses only fg/bold; component rendering needs no full theme state.
  return renderCall(args, theme as Theme, context)
    .render(120)
    .map(line => line.trimEnd())
    .join("\n")
}

test("priority_relative renders the moved task once, direction and reference", async () => {
  const rendered = await render({
    action: "priority_relative",
    id: 7,
    referenceId: 3,
    position: "above",
  })

  assert.equal(rendered, "todo priority_relative #7 above #3")
})

test("priority_order renders the ordered id sequence", async () => {
  const rendered = await render({ action: "priority_order", ids: [4, 9, 2] })

  assert.equal(rendered, "todo priority_order order #4 #9 #2")
})
