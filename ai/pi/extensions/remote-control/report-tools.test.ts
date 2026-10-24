import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import test from "node:test"
import { Effect, Either } from "effect"
import { Type } from "typebox"
import {
  createReportJobs,
  REPORT_JOB_ENTRY,
  type ReportSnapshot,
} from "./report-jobs.ts"
import { createOwnerAllowance } from "../classified-workflows/owner-allowance.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const start = source.indexOf("export default function remoteControl(")
const end = source.indexOf("  pi.events.on(QUESTION_STATE_EVENT", start)
assert.ok(start >= 0 && end > start)
const initializer = stripTypeScriptTypes(
  source.slice(start, end).replace("export default ", "") + "\n}",
)

export const reportToolsFixture = async (
  extra: Record<string, unknown> = {},
  options: object = {},
) => {
  let sent = 0
  const ui: string[] = []
  const tools = new Map<string, { execute: Function }>()
  const factory = runInNewContext(`${initializer}\n;remoteControl`, {
    Effect,
    Either,
    Type,
    createReportJobs,
    REPORT_JOB_ENTRY,
    registerRuntimeVersion: () => {},
    makeRemoteBridgeStore: () => ({}),
    remoteBridgeDatabasePath: () => "fixture",
    homedir: () => "/fixture",
    process: { env: {} },
    bridgeAgentLabel: () => "agent-fixture",
    agentReportText: (text: string, sender: string) =>
      `Agent report · ${sender}\n\n${text}`,
    deliverPreparedOwnerRelay: () =>
      Effect.sync(() => {
        sent++
      }),
    deliverOwnerRelay: () =>
      Effect.sync(() => {
        sent++
      }),
    deliverStakeholderUpdate: () =>
      Effect.sync(() => {
        sent++
      }),
    safeDeliveryError: () => "fixture failure",
    ...extra,
  })
  const pi = {
    registerTool: (tool: { name: string; execute: Function }) =>
      tools.set(tool.name, tool),
    on: () => {},
    appendEntry: () => {},
  }
  factory(pi, undefined, options)
  return {
    tools,
    sent: () => sent,
    ui,
    ctx: {
      cwd: "/fixture",
      hasUI: true,
      ui: {
        setStatus: (_key: string, text: string) => {
          ui.push(String(text))
        },
        setWidget: (_key: string, lines: string[]) => {
          ui.push(String(lines))
        },
        notify: () => {},
      },
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "session-fixture",
      },
    },
  }
}

test("terminal report history does not remain above the prompt", async () => {
  let present: (snapshots: readonly ReportSnapshot[]) => void = () => {}
  const fixture = await reportToolsFixture({
    createReportJobs: (runtime: Parameters<typeof createReportJobs>[0]) => {
      present = runtime.present
      return createReportJobs(runtime)
    },
  })
  await fixture.tools
    .get("report_delivery")
    ?.execute("list", { action: "status" }, undefined, undefined, fixture.ctx)
  const base = {
    kind: "owner-report" as const,
    createdAt: 1,
    updatedAt: 2,
    sender: "fixture",
    characters: 10,
  }
  present([
    {
      ...base,
      id: "b7f0b104-a328-4655-b1ec-6933f5d446f3",
      status: "needs-revision",
      pass: 2,
    },
    {
      ...base,
      id: "5ee03d58-08a3-4319-abba-0f382bc50a1d",
      status: "delivered",
      pass: 1,
    },
  ])
  assert.ok(
    !fixture.ui.some(
      line => line.includes("b7f0b104") || line.includes("5ee03d58"),
    ),
    "terminal jobs belong in history, not persistent prompt rows",
  )
})

test("actual report tool cannot send when its internal critic is unavailable", async () => {
  const fixture = await reportToolsFixture()
  const tool = fixture.tools.get("report_owner")
  assert.ok(tool)
  const result = await tool.execute(
    "report-1",
    { text: "A complete fixture status report." },
    undefined,
    undefined,
    fixture.ctx,
  )
  assert.equal(
    fixture.sent(),
    0,
    "missing internal critique must never reach Telegram transport",
  )
  assert.equal(result.details.outcome, "review-unavailable")
})

test("actual reporting tool returns immediately and shows background processing without another model turn", async t => {
  const guard = createOwnerAllowance({
    now: Date.now,
    schedule: (callback, delay) => setTimeout(callback, delay),
    clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    persist: () => {},
    cancel: () => {},
  })
  t.after(() => guard.dispose())
  assert.ok(Either.isRight(guard.ownerInput(Date.now())))
  let finish: (output: string) => void = () => {}
  let reviewed = ""
  const fixture = await reportToolsFixture(
    {},
    {
      reporting: {
        execution: guard,
        process: async (_ctx: unknown, task: { prompt: string }) => {
          reviewed = task.prompt
          return new Promise(resolve => {
            finish = resolve
          })
        },
      },
    },
  )
  const result = await fixture.tools
    .get("report_owner")
    ?.execute(
      "report-2",
      { text: "81 focused tests pass; native SDK timing is not live." },
      undefined,
      undefined,
      fixture.ctx,
    )
  assert.equal(result.details.outcome, "queued")
  assert.equal(fixture.sent(), 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(reviewed, /Agent report · agent-fixture/)
  assert.match(reviewed, /Verified transport-owned envelope/)
  assert.match(reviewed, /not a delivery receipt/)
  assert.ok(fixture.ui.some(line => line.includes("reviewing 1/2")))
  finish(
    JSON.stringify({
      admissible: true,
      reason: "Complete review, no meaningful defects.",
      coverage: "complete",
    }),
  )
  for (let i = 0; i < 10 && fixture.sent() === 0; i++)
    await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.sent(), 1)
  const status = await fixture.tools
    .get("report_delivery")
    ?.execute(
      "status",
      { action: "status", jobId: result.details.jobId },
      undefined,
      undefined,
      fixture.ctx,
    )
  assert.equal(status.details.jobs[0].status, "delivered")
})
