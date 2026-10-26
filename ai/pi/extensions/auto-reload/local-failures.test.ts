import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"

type Reporter = (
  severity: "error" | "warning",
  operation: string,
  summary: string,
) => void

type LocalMessage = {
  readonly customType: string
  readonly content: string
  readonly display: boolean
}

const failureReporter = () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = source.indexOf("  const reportIncident =")
  const end = source.indexOf("  let watchers:", start)
  assert.ok(start >= 0 && end > start)
  const messages: {
    readonly message: LocalMessage
    readonly options: unknown
  }[] = []
  const routed: unknown[] = []
  const api = {
    events: {
      emit: (_name: string, value: unknown) => routed.push(value),
    },
    sendMessage: (message: LocalMessage, options: unknown) =>
      messages.push({ message, options }),
  }
  const report: Reporter = new Function(
    "pi",
    `${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })}
     return reportIncident;`,
  )(api)
  return { report, messages, routed }
}

test("reload failure stays visible locally without routing or starting a turn", () => {
  const runtime = failureReporter()
  runtime.report("error", "automatic extension reload", "probe failed")
  assert.deepEqual(runtime.messages, [
    {
      message: {
        customType: "auto-reload.failure",
        content: "error: automatic extension reload: probe failed",
        display: true,
      },
      options: { triggerTurn: false },
    },
  ])
  assert.deepEqual(runtime.routed, [])
})

test("local reload failure retains bounded single-line diagnostics", () => {
  const runtime = failureReporter()
  runtime.report(
    "warning",
    "watch managed Pi resources",
    `\u001b\n${"x".repeat(400)}`,
  )
  assert.equal(runtime.messages.length, 1)
  const message = runtime.messages[0]?.message
  assert.ok(message)
  const prefix = "warning: watch managed Pi resources: "
  assert.ok(message.content.startsWith(prefix))
  assert.equal(message.content.slice(prefix.length).length, 240)
  assert.doesNotMatch(message.content, /[\u0000-\u001f\u007f]/u)
  assert.deepEqual(runtime.routed, [])
})
