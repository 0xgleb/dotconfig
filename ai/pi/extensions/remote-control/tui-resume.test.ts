import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { HUMAN_TURN_EVENT } from "../shared/usage-governor-events.ts"
import { stripTypeScriptTypes } from "node:module"
import { runInNewContext } from "node:vm"
import {
  AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import { InteractiveMode } from "/nix/store/nxskv7qzx13yi7a6q1fwwqiykhmjgjib-pi-coding-agent-1.3.0/lib/node_modules/pi-monorepo/dist/modes/interactive/interactive-mode.js"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"
import { resumeWorkers, resumeOutcomeText } from "./resume.ts"
import { registerOwnerAllowance } from "../classified-workflows/owner-allowance-extension.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const start = source.indexOf("  const handleTuiResumeInput = async (")
const end = source.indexOf('  pi.on("turn_end",', start)

type Input = {
  readonly type: "input"
  readonly text: string
  readonly source: string
  readonly images?: unknown
}
type InputResult = { readonly action: "continue" | "handled" }

const fixture = async (t: test.TestContext) => {
  assert.ok(
    start >= 0 && end > start,
    "owner-only TUI resume implementation is absent",
  )
  const root = mkdtempSync(join(tmpdir(), "pi-tui-resume-"))
  t.after(() => rmSync(root, { recursive: true }))
  const store = makeRemoteBridgeStore(join(root, "bridge.sqlite"))
  const now = Date.now()
  for (const id of ["a", "b", "dead", "manager"])
    await Effect.runPromise(
      store.heartbeatAgent({
        id,
        label: id,
        cwd: `/work/${id}`,
        accepting: id !== "b",
        workDelivery: "native-pi",
        ...(id === "manager" ? { nativeManager: true as const } : {}),
        now: id === "dead" ? now - 2000 : now,
        ttlMs: id === "dead" ? 1000 : 60000,
      }),
    )
  const inputHandlers: ((
    event: Input,
    ctx: unknown,
  ) => InputResult | undefined | Promise<InputResult | undefined>)[] = []
  const notices: string[] = []
  const ctx = {
    cwd: "/work/a",
    model: { provider: "fixture" },
    sessionManager: { getSessionId: () => "a" },
    ui: {
      setStatus: () => {},
      notify: (text: string) => {
        notices.push(text)
      },
    },
    abort: () => {},
  }
  const ownerTurns: string[] = []
  const pi = {
    events: {
      emit: (name: string) => {
        ownerTurns.push(name)
      },
    },
    on: (name: string, handler: (typeof inputHandlers)[number]) => {
      if (name === "input") inputHandlers.push(handler)
    },
    registerCommand: (name: string) => {
      assert.notEqual(
        name,
        "resume-work",
        "ordinary registered commands bypass trusted input provenance",
      )
    },
    appendEntry: () => {},
  }
  const guard = registerOwnerAllowance(pi as unknown as ExtensionAPI, () => {})
  t.after(() => guard.dispose())
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
    pi,
    store,
    Effect,
    Either,
    randomUUID,
    resumeWorkers,
    resumeOutcomeText,
    HUMAN_TURN_EVENT,
    options: { reporting: { execution: guard } },
    onAuthenticatedOwnerMessage: (at: number) => {
      guard.ownerInput(at)
    },
    run: (operation: Effect.Effect<unknown, unknown>) =>
      Effect.runPromise(Effect.either(operation)),
    isLocalDispatchProvider: () => false,
  })
  let providerStarts = 0
  const session: AgentSession = Object.create(AgentSession.prototype)
  Object.defineProperty(session, "isStreaming", { value: false })
  Object.defineProperty(session, "model", { value: { provider: "fixture" } })
  Object.defineProperty(session, "promptTemplates", { value: [] })
  Object.assign(session, {
    _extensionRunner: {
      getCommand: () => undefined,
      hasHandlers: () => true,
      emitInput: async (text: string, images: unknown, source: string) => {
        for (const handler of inputHandlers) {
          const result = await handler(
            { type: "input", text, source, images },
            ctx,
          )
          if (result?.action === "handled") return result
        }
        return { action: "continue" }
      },
    },
    _modelRuntime: { hasConfiguredAuth: () => true },
    _startRun: async () => {
      providerStarts++
    },
  })
  const submissions: Promise<void>[] = []
  let sessionPickers = 0
  const editor = {
    onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
    setText: () => {},
  }
  const mode = Object.create(InteractiveMode.prototype)
  Object.defineProperties(mode, {
    session: { value: session },
    editor: { value: editor },
  })
  Object.assign(mode, {
    defaultEditor: editor,
    flushPendingBashComponents: () => {},
    showSessionSelector: () => {
      sessionPickers++
    },
    onInputCallback: (text: string) => {
      submissions.push(session.prompt(text))
    },
  })
  const bindSubmit: unknown = Reflect.get(
    InteractiveMode.prototype,
    "setupEditorSubmitHandler",
  )
  assert.equal(typeof bindSubmit, "function")
  if (typeof bindSubmit !== "function")
    return assert.fail("native editor submit binding is absent")
  bindSubmit.call(mode)
  const submitTui = async (text: string) => {
    assert.ok(editor.onSubmit)
    await editor.onSubmit(text)
    await Promise.all(submissions)
  }
  const queued = () =>
    Effect.runPromise(store.listAgents(Date.now(), { includeExpired: true }))
  return {
    session,
    store,
    submitTui,
    sessionPickers: () => sessionPickers,
    guard,
    queued,
    notices,
    ownerTurns,
    providerStarts: () => providerStarts,
  }
}

test("native editor /resume-work queues owner input for every live worker, including busy ones", async t => {
  const f = await fixture(t)
  await f.submitTui("/resume-work")
  const agents = await f.queued()
  assert.equal(agents.find(agent => agent.id === "a")?.queuedMessages, 1)
  assert.equal(agents.find(agent => agent.id === "b")?.queuedMessages, 1)
  assert.equal(agents.find(agent => agent.id === "dead")?.queuedMessages, 0)
  assert.equal(agents.find(agent => agent.id === "manager")?.queuedMessages, 0)
  assert.match(f.notices.join("\n"), /Skipped.*dead/)
  assert.deepEqual(f.ownerTurns, [HUMAN_TURN_EVENT])
  assert.equal(f.providerStarts(), 0)
})

test("deduplicated resume results distinguish queued, delivering, accepted and failed input", async t => {
  const f = await fixture(t)
  const input = {
    requesterId: "owner-pane" as const,
    invocationId: "dedupe-status",
  }
  const queued = await Effect.runPromise(resumeWorkers(f.store, input))
  assert.match(resumeOutcomeText(queued), /Queued: a/)
  const a = await Effect.runPromise(
    f.store.claimNext({ agentId: "a", now: Date.now() }),
  )
  assert.equal(a?.status, "claimed")
  if (a?.status !== "claimed") return assert.fail("a was not claimed")
  const delivering = await Effect.runPromise(resumeWorkers(f.store, input))
  assert.match(resumeOutcomeText(delivering), /Delivering: a/)
  await Effect.runPromise(
    f.store.complete({
      messageId: a.id,
      claimToken: a.claimToken,
      response: "Input accepted",
      now: Date.now(),
    }),
  )
  const b = await Effect.runPromise(
    f.store.claimNext({ agentId: "b", now: Date.now() }),
  )
  assert.equal(b?.status, "claimed")
  if (b?.status !== "claimed") return assert.fail("b was not claimed")
  await Effect.runPromise(
    f.store.fail({
      messageId: b.id,
      claimToken: b.claimToken,
      failure: "aborted",
      now: Date.now(),
    }),
  )
  const final = await Effect.runPromise(resumeWorkers(f.store, input))
  assert.match(resumeOutcomeText(final), /Input already accepted: a/)
  assert.match(resumeOutcomeText(final), /Skipped \(aborted\): b/)
})

test("native editor /resume keeps the existing saved-session selector", async t => {
  const f = await fixture(t)
  await f.submitTui("/resume")
  assert.equal(f.sessionPickers(), 1)
  assert.equal(
    (await f.queued()).some(agent => agent.queuedMessages > 0),
    false,
  )
  assert.equal(f.providerStarts(), 0)
})

for (const route of ["extension", "rpc", "arguments"] as const) {
  test(`real host ${route} route cannot invoke owner-only TUI resume`, async t => {
    const f = await fixture(t)
    f.guard.ownerInput(Date.now())
    if (route === "extension")
      await f.session.sendUserMessage("/resume-work", {
        expandPromptTemplates: true,
      })
    else if (route === "rpc")
      await f.session.prompt("/resume-work", { source: "rpc" })
    else await f.session.prompt("/resume-work a")
    assert.equal(
      (await f.queued()).some(agent => agent.queuedMessages > 0),
      false,
    )
    assert.equal(f.providerStarts(), 0)
    assert.deepEqual(f.ownerTurns, [])
  })
}

test("concurrent extension invocation cannot borrow the interactive owner's authority", async t => {
  const f = await fixture(t)
  await Promise.all([
    f.submitTui("/resume-work"),
    f.session.sendUserMessage("/resume-work"),
  ])
  assert.equal(
    (await f.queued()).find(agent => agent.id === "a")?.queuedMessages,
    1,
  )
  assert.equal(
    (await f.queued()).find(agent => agent.id === "b")?.queuedMessages,
    1,
  )
  assert.deepEqual(f.ownerTurns, [HUMAN_TURN_EVENT])
  assert.equal(f.providerStarts(), 0)
})
