import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { loadHostExtension } from "../../../test/pi-host-test-support.mjs"
import {
  QUESTION_REMOTE_RESOLUTION_EVENT,
  QUESTION_STATE_ENTRY,
} from "../shared/question-events.ts"

const fixture = async () => {
  const entries: Record<string, unknown>[] = [
    {
      type: "custom",
      customType: QUESTION_STATE_ENTRY,
      data: {
        nextId: 2,
        questions: [
          {
            id: 1,
            status: "pending",
            question: "Which manager scope should be used?",
          },
        ],
      },
    },
  ]
  const hooks = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >()
  const listeners = new Map<string, ((value: unknown) => void)[]>()
  const sent: {
    message: Record<string, unknown>
    options: Record<string, unknown>
  }[] = []
  const pi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    events: {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener])
        return () => {}
      },
      emit: (name: string, value: unknown) => {
        for (const listener of listeners.get(name) ?? []) listener(value)
      },
    },
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data })
    },
    sendMessage: (
      message: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      sent.push({ message, options })
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/projects/worker",
    hasUI: false,
    mode: "tui",
    sessionManager: { getSessionId: () => "worker", getBranch: () => entries },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  } as unknown as ExtensionContext
  const extension = await loadHostExtension(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  )
  assert.equal(typeof extension, "function")
  extension(pi)
  for (const handler of hooks.get("session_start") ?? []) await handler({}, ctx)
  return {
    sent,
    entries,
    answer: () =>
      pi.events.emit(QUESTION_REMOTE_RESOLUTION_EVENT, {
        id: 1,
        answer: "One manager for all workers.",
      }),
  }
}

test("authenticated answer notification steers the active worker without model polling", async () => {
  const f = await fixture()
  f.answer()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].message.customType, "pi.questions.answered")
  assert.equal(f.sent[0].options.triggerTurn, true)
  assert.equal(f.sent[0].options.deliverAs, "steer")
  assert.match(
    String(f.sent[0].message.content),
    /One manager for all workers\./,
  )
})

test("repeated answer delivery does not enqueue another model notification", async () => {
  const f = await fixture()
  f.answer()
  f.answer()
  assert.equal(f.sent.length, 1)
})
