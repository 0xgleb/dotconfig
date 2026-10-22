import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import { readPromptFile } from "../shared/prompt-text.ts"
import { decodeManagerSummary, type ManagerSummary } from "./manager-core.ts"
import {
  openNativeManagerState,
  prepareNativeManagerState,
  type NativeManagerState,
} from "./manager-native-state.ts"
import {
  managerPairDirectory,
  managerSessionLaunchPlan,
  ManagerSessionError,
} from "./manager-session-core.ts"

export interface NativeManagerWorker {
  readonly snapshot: (
    ctx: ExtensionContext,
  ) => Either.Either<Readonly<Record<string, unknown>>, ManagerSessionError>
  readonly priorityId: (ctx: ExtensionContext) => string
  readonly priorities: (
    ctx: ExtensionContext,
    text: string,
  ) => Either.Either<string, ManagerSessionError>
}

export interface NativeManagerRuntime {
  readonly agentDir: string
  readonly piExecutable: string
  readonly schedule: (tick: () => void) => () => void
}

export interface NativeManager {
  readonly isManager: () => boolean
  readonly open: (ctx: ExtensionContext) => Promise<void>
  readonly command: (ctx: ExtensionContext, text: string) => void
}

export const registerNativeManager = (
  pi: ExtensionAPI,
  worker: NativeManagerWorker,
  runtime: NativeManagerRuntime = nativeRuntime(),
): NativeManager => {
  pi.registerFlag("manager-worker", {
    description: "Pair a native manager chat with a worker session",
    type: "string",
  })
  const isManager = () =>
    pi.getFlag("manager-worker") !== undefined &&
    pi.getFlag("manager-worker") !== ""
  let cancelPolling: (() => void) | undefined
  let policyReady = false
  const submitted = new Set<string>()
  const delivering = new Set<string>()

  const notice = (ctx: ExtensionContext, error: ManagerSessionError) =>
    ctx.ui.notify(error.message, "warning")
  const stop = () => {
    cancelPolling?.()
    cancelPolling = undefined
    delivering.clear()
  }
  const binding = (ctx: ExtensionContext) => {
    const selected = isManager()
      ? pi.getFlag("manager-worker")
      : ctx.sessionManager.getSessionId()
    if (typeof selected !== "string")
      return failed("invalid_input", "Manager worker identity is invalid.")
    return Either.map(
      managerPairDirectory({
        agentDir: runtime.agentDir,
        workerCwd: ctx.cwd,
        workerSessionId: selected,
      }),
      directory => ({
        directory,
        scope: { workerSessionId: selected, cwd: ctx.cwd },
      }),
    )
  }
  const client = (ctx: ExtensionContext) =>
    Either.flatMap(binding(ctx), target =>
      openNativeManagerState(target.directory, target.scope),
    )

  const deliver = (ctx: ExtensionContext, key: string, content: string) => {
    const persisted = ctx.sessionManager
      .getBranch()
      .some(
        entry =>
          entry.type === "message" &&
          entry.message.role === "custom" &&
          entry.message.customType === NATIVE_MESSAGE &&
          record(entry.message.details) &&
          entry.message.details.key === key,
      )
    if (persisted || delivering.has(key)) return
    delivering.add(key)
    const sent = attempt(() =>
      pi.sendMessage(
        {
          customType: NATIVE_MESSAGE,
          content,
          display: true,
          details: { key },
        },
        { triggerTurn: false },
      ),
    )
    if (Either.isLeft(sent)) {
      delivering.delete(key)
      notice(ctx, sent.left)
    }
  }
  const pollManager = (ctx: ExtensionContext) => {
    const state = client(ctx)
    if (Either.isLeft(state)) return
    const current = state.right.context()
    if (
      Either.isRight(current) &&
      current.right.data.roundReport !== null &&
      current.right.data.roundReport !== undefined
    ) {
      const report = decodeManagerSummary(current.right.data.roundReport)
      if (Either.isRight(report) && report.right.status !== "started") {
        deliver(ctx, `round-${report.right.round}`, reportText(report.right))
      }
    }
    for (const id of submitted) {
      const receipt = state.right.receipt(id)
      if (Either.isRight(receipt) && receipt.right) {
        deliver(ctx, `priority-${id}`, receipt.right.message)
        submitted.delete(id)
      }
    }
  }

  const startWorker = (
    ctx: ExtensionContext,
    state: NativeManagerState,
    epoch: string,
  ) => {
    let lastLeaf: string | undefined
    const tick = () => {
      const applied = state.processPriorities(
        () => `${epoch}-${worker.priorityId(ctx)}`,
        text => worker.priorities(ctx, text),
      )
      if (Either.isLeft(applied)) {
        notice(ctx, applied.left)
        return
      }
      const leaf = ctx.sessionManager.getBranch().at(-1)?.id
      if (leaf === lastLeaf && lastLeaf !== undefined) return
      const snapshot = worker.snapshot(ctx)
      const published = state.publish({
        version: 1,
        workerSessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        observedAt: Date.now(),
        priorityRevision: `${epoch}-${worker.priorityId(ctx)}`,
        data: Either.isRight(snapshot)
          ? snapshot.right
          : { status: "unavailable", reason: snapshot.left.message },
      })
      if (Either.isLeft(published)) notice(ctx, published.left)
      else lastLeaf = leaf
    }
    stop()
    tick()
    cancelPolling = runtime.schedule(tick)
  }

  const epochFor = (ctx: ExtensionContext, mode: "restore" | "replace") => {
    const previous = ctx.sessionManager
      .getBranch()
      .findLast(
        entry => entry.type === "custom" && entry.customType === SCOPE_ENTRY,
      )
    if (mode === "restore" && previous?.type === "custom") {
      if (
        !record(previous.data) ||
        previous.data.version !== 1 ||
        typeof previous.data.epoch !== "string" ||
        !/^[0-9a-f-]{36}$/u.test(previous.data.epoch)
      ) {
        return failed(
          "unsafe_state",
          "Stored native manager scope is malformed.",
        )
      }
      return Either.right(previous.data.epoch)
    }
    const epoch = randomUUID()
    return Either.map(
      attempt(() => pi.appendEntry(SCOPE_ENTRY, { version: 1, epoch })),
      () => epoch,
    )
  }
  const resume = (ctx: ExtensionContext, mode: "restore" | "replace") => {
    stop()
    if (isManager()) {
      pi.setActiveTools([...MANAGEMENT_TOOLS])
      pollManager(ctx)
      cancelPolling = runtime.schedule(() => pollManager(ctx))
      return
    }
    const target = binding(ctx)
    if (Either.isLeft(target) || !existsSync(target.right.directory)) return
    const state = openNativeManagerState(
      target.right.directory,
      target.right.scope,
    )
    const epoch = epochFor(ctx, mode)
    if (Either.isLeft(state)) notice(ctx, state.left)
    else if (Either.isLeft(epoch)) notice(ctx, epoch.left)
    else startWorker(ctx, state.right, epoch.right)
  }

  pi.on("session_start", (_event, ctx) => resume(ctx, "restore"))
  pi.on("session_tree", (_event, ctx) => resume(ctx, "replace"))
  pi.on("session_shutdown", stop)
  pi.on("before_agent_start", (event, ctx) => {
    if (!isManager()) return
    pi.setActiveTools([...MANAGEMENT_TOOLS])
    const policy = attempt(() => readPromptFile("manager-system.md"))
    if (Either.isLeft(policy)) {
      policyReady = false
      notice(ctx, policy.left)
      ctx.abort()
      return
    }
    policyReady = true
    const state = client(ctx)
    const current = Either.flatMap(state, value => value.context())
    const observation = Either.isRight(current)
      ? current.right
      : { status: "unavailable", reason: current.left.message }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${policy.right}`,
      message: {
        customType: "manager-worker-observation",
        content: JSON.stringify(observation),
        display: false,
      },
    }
  })
  pi.on("before_provider_request", (_event, ctx) => {
    if (isManager() && (!policyReady || ctx.model?.provider === "anthropic"))
      ctx.abort()
  })
  pi.on("tool_call", event =>
    isManager() && !MANAGEMENT_TOOLS.includes(event.toolName)
      ? {
          block: true,
          reason:
            "Manager sessions permit management tools, not coding execution.",
        }
      : undefined,
  )

  return {
    isManager,
    command: (ctx, text) => {
      if (!text || text === "history") {
        ctx.ui.notify("This is the native manager chat.", "info")
        return
      }
      const state = client(ctx)
      if (Either.isLeft(state)) {
        notice(ctx, state.left)
        return
      }
      const current = state.right.context()
      if (Either.isLeft(current)) {
        notice(ctx, current.left)
        return
      }
      if (text === "summary") {
        const report = decodeManagerSummary(current.right.data.roundReport)
        if (Either.isLeft(report))
          ctx.ui.notify("No completed worker report is available.", "info")
        else if (report.right.status !== "started")
          deliver(
            ctx,
            `requested-report-${randomUUID()}`,
            reportText(report.right),
          )
        return
      }
      if (!text.startsWith("priorities ")) {
        ctx.ui.notify(
          "Use /manager priorities <ids> to commit an order.",
          "info",
        )
        return
      }
      const queued = state.right.enqueuePriorities(
        text.slice("priorities ".length),
        current.right.priorityRevision,
      )
      if (Either.isLeft(queued)) notice(ctx, queued.left)
      else {
        submitted.add(queued.right)
        ctx.ui.notify("Priority change queued for the worker.", "info")
      }
    },
    open: async ctx => {
      const queried = await Effect.runPromise(
        Effect.either(
          Effect.tryPromise({
            try: () =>
              pi.exec("zellij", ["action", "list-panes", "--json"], {
                timeout: 5000,
              }),
            catch: () =>
              new ManagerSessionError({
                code: "launch_failed",
                message: "Could not query the manager workspace.",
              }),
          }),
        ),
      )
      if (Either.isLeft(queried) || queried.right.code !== 0) {
        ctx.ui.notify(
          "Native manager chat requires an available Zellij session.",
          "warning",
        )
        return
      }
      const names = decodePaneNames(queried.right.stdout)
      if (Either.isLeft(names)) {
        notice(ctx, names.left)
        return
      }
      if (!ctx.model) {
        ctx.ui.notify("Select a model before opening manager chat.", "warning")
        return
      }
      const plan = managerSessionLaunchPlan({
        workerSessionId: ctx.sessionManager.getSessionId(),
        workerCwd: ctx.cwd,
        agentDir: runtime.agentDir,
        piExecutable: runtime.piExecutable,
        provider: ctx.model.provider,
        modelId: ctx.model.id,
        existingPaneNames: names.right,
      })
      if (Either.isLeft(plan)) {
        notice(ctx, plan.left)
        return
      }
      const target = binding(ctx)
      if (Either.isLeft(target)) {
        notice(ctx, target.left)
        return
      }
      const state = prepareNativeManagerState(
        target.right.directory,
        target.right.scope,
      )
      const epoch = epochFor(ctx, "restore")
      if (Either.isLeft(state)) {
        notice(ctx, state.left)
        return
      }
      if (Either.isLeft(epoch)) {
        notice(ctx, epoch.left)
        return
      }
      startWorker(ctx, state.right, epoch.right)
      if (plan.right.kind === "existing") {
        ctx.ui.notify(
          `Manager is running in pane ${plan.right.paneName}.`,
          "info",
        )
        return
      }
      const launch = plan.right
      const launched = await Effect.runPromise(
        Effect.either(
          Effect.tryPromise({
            try: () =>
              pi.exec(launch.executable, [...launch.args], { timeout: 15000 }),
            catch: () =>
              new ManagerSessionError({
                code: "launch_failed",
                message: "Native manager launch failed.",
              }),
          }),
        ),
      )
      if (Either.isLeft(launched) || launched.right.code !== 0)
        ctx.ui.notify("Native manager launch failed.", "warning")
    },
  }
}

const MANAGEMENT_TOOLS: readonly string[] = ["agent_registry"]
const SCOPE_ENTRY = "manager.native-scope.v1"
const NATIVE_MESSAGE = "manager-native-update"

const reportText = (
  report: Exclude<ManagerSummary, { status: "started" }>,
): string =>
  `**Manager round report · ${report.elapsedMs}ms**\n\n${report.text}`

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const failed = (code: ManagerSessionError["code"], message: string) =>
  Either.left(new ManagerSessionError({ code, message }))
const attempt = <A>(run: () => A): Either.Either<A, ManagerSessionError> =>
  Either.try({
    try: run,
    catch: () =>
      new ManagerSessionError({
        code: "io",
        message: "Native manager runtime operation failed.",
      }),
  })
const nativeRuntime = (): NativeManagerRuntime => ({
  agentDir: getAgentDir(),
  piExecutable: join(getAgentDir(), "bin", "pi"),
  schedule: tick => {
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  },
})

const decodePaneNames = (
  text: string,
): Either.Either<readonly string[], ManagerSessionError> =>
  Either.gen(function* () {
    const parsed: unknown = yield* Either.try({
      try: (): unknown => JSON.parse(text),
      catch: () =>
        new ManagerSessionError({
          code: "protocol",
          message: "Invalid Zellij pane metadata.",
        }),
    })
    if (!Array.isArray(parsed) || !parsed.every(record))
      return yield* failed("protocol", "Invalid Zellij pane metadata.")
    const names: string[] = []
    for (const pane of parsed) {
      const name = pane.pane_name ?? pane.title ?? pane.name
      if (name === null || name === undefined || name === "") continue
      if (typeof name !== "string")
        return yield* failed("protocol", "Invalid Zellij pane name.")
      names.push(name)
    }
    return names
  })
