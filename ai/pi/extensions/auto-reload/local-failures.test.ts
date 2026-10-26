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

const failureReporter = (sendFailure?: Error) => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = source.indexOf("  const reportIncident =")
  const end = source.indexOf("  let watchers:", start)
  assert.ok(start >= 0 && end > start)
  const messages: {
    readonly message: LocalMessage
    readonly options: unknown
  }[] = []
  const routed: unknown[] = []
  const logs: string[] = []
  const api = {
    events: {
      emit: (_name: string, value: unknown) => routed.push(value),
    },
    sendMessage: (message: LocalMessage, options: unknown) => {
      if (sendFailure) throw sendFailure
      messages.push({ message, options })
    },
  }
  const report: Reporter = new Function(
    "pi",
    "console",
    `${stripTypeScriptTypes(source.slice(start, end), { mode: "strip" })}
     return reportIncident;`,
  )(api, { error: (record: string) => logs.push(record) })
  return { report, messages, routed, logs }
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

test("a stale notice sender cannot interrupt recovery or expose its error", () => {
  const runtime = failureReporter(new Error("sensitive sender sentinel"))
  assert.doesNotThrow(() =>
    runtime.report(
      "error",
      "automatic extension reload",
      "sensitive summary sentinel",
    ),
  )
  assert.deepEqual(runtime.messages, [])
  assert.deepEqual(runtime.routed, [])
  assert.deepEqual(
    runtime.logs.map(record => JSON.parse(record)),
    [
      {
        level: "error",
        component: "auto-reload",
        event: "notice-delivery-failed",
        operation: "automatic extension reload",
      },
    ],
  )
  assert.doesNotMatch(runtime.logs.join("\n"), /sensitive/u)
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
