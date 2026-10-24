import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync } from "node:fs"
import { Type } from "typebox"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import { readPromptFile } from "../shared/prompt-text.ts"
import { registerManagerBinding } from "../shared/manager-binding.ts"
import type { TodoRequest } from "../todo/state.ts"
import { decodeManagerSummary, type ManagerSummary } from "./manager-core.ts"
import {
  openNativeManagerState,
  prepareNativeManagerState,
  type NativeManagerState,
} from "./manager-native-state.ts"
import {
  managerPairDirectory,
  globalManagerSessionLaunchPlan,
  ManagerSessionError,
} from "./manager-session-core.ts"
import {
  readManagerTarget,
  selectManagerTarget,
  type ManagerTarget,
} from "./manager-target.ts"

export interface NativeManagerWorker {
  readonly todo?: (
    ctx: ExtensionContext,
    request: TodoRequest,
  ) => Either.Either<string, ManagerSessionError>
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
  pi.registerFlag("manager", {
    description: "Run the native manager for all existing workers",
    type: "boolean",
  })
  pi.registerFlag("manager-worker", {
    description: "Pair a native manager chat with a worker session",
    type: "string",
  })
  const isManager = () =>
    (pi.getFlag("manager") !== undefined && pi.getFlag("manager") !== false) ||
    (pi.getFlag("manager-worker") !== undefined &&
      pi.getFlag("manager-worker") !== "")
  let cancelPolling: (() => void) | undefined
  let policyReady = false
  let activeSessionId: string | undefined
  let activeCtx: ExtensionContext | undefined
  let controlRegistered = false
  const releaseBinding = registerManagerBinding(pi, sessionId => {
    if (sessionId !== activeSessionId) return undefined
    if (!isManager()) return { role: "worker" }
    if (!activeCtx)
      return {
        role: "manager-unavailable",
        message: "Manager context is unavailable.",
      }
    const target = managerTarget(activeCtx)
    return Either.isRight(target)
      ? {
          role: "manager",
          workerSessionId: target.right.workerSessionId,
          workerCwd: target.right.cwd,
        }
      : { role: "manager-unavailable", message: target.left.message }
  })
  const submitted = new Set<string>()
  const delivering = new Set<string>()

  const notice = (ctx: ExtensionContext, error: ManagerSessionError) =>
    ctx.ui.notify(error.message, "warning")
  const stop = () => {
    cancelPolling?.()
    cancelPolling = undefined
    delivering.clear()
  }
  const managerTarget = (
    ctx: ExtensionContext,
  ): Either.Either<ManagerTarget, ManagerSessionError> => {
    const selected = readManagerTarget(ctx)
    if (Either.isLeft(selected)) return selected
    if (selected.right) return Either.right(selected.right)
    const legacy = pi.getFlag("manager-worker")
    if (typeof legacy === "string" && legacy)
      return Either.right({ workerSessionId: legacy, cwd: ctx.cwd })
    return failed(
      "unavailable",
      "Select an existing worker with manager_control before using its backlog or priorities. Discover workers with agent_registry.",
    )
  }
  const binding = (ctx: ExtensionContext) =>
    Either.flatMap(
      isManager()
        ? managerTarget(ctx)
        : Either.right({
            workerSessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
          }),
      scope =>
        Either.map(
          managerPairDirectory({
            agentDir: runtime.agentDir,
            workerCwd: scope.cwd,
            workerSessionId: scope.workerSessionId,
          }),
          directory => ({ directory, scope }),
        ),
    )
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
      if (
        Either.isRight(receipt) &&
        receipt.right &&
        receipt.right.status !== "started"
      ) {
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
    const sessionId = ctx.sessionManager.getSessionId()
    const cwd = ctx.cwd
    const todo = worker.todo
    const tick = () => {
      if (ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd)
        return
      const applied = state.processPriorities(
        () => `${epoch}-${worker.priorityId(ctx)}`,
        text => worker.priorities(ctx, text),
        todo ? request => todo(ctx, request) : undefined,
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
  const registerControl = () => {
    if (controlRegistered) return
    pi.registerTool({
      name: "manager_control",
      label: "Manager worker control",
      description:
        "Select an existing worker using its session ID and cwd from agent_registry, inspect the selection, or queue confirmed priorities. Does not start worker rounds.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("select"),
          Type.Literal("current"),
          Type.Literal("priorities"),
        ]),
        workerSessionId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        order: Type.Optional(Type.String()),
      }),
      execute: async (_id, params, _signal, _update, ctx) => {
        if (!isManager())
          return controlError(
            new ManagerSessionError({
              code: "unauthorized",
              message: "Worker selection is available only in the manager.",
            }),
          )
        if (params.action === "select") {
          if (
            typeof params.workerSessionId !== "string" ||
            typeof params.cwd !== "string"
          )
            return controlError(
              new ManagerSessionError({
                code: "invalid_input",
                message:
                  "Select requires an existing worker session ID and absolute cwd.",
              }),
            )
          const selected = selectManagerTarget(
            pi,
            ctx,
            { workerSessionId: params.workerSessionId, cwd: params.cwd },
            runtime.agentDir,
          )
          return Either.isLeft(selected)
            ? controlError(selected.left)
            : {
                content: [
                  {
                    type: "text" as const,
                    text: `Selected worker ${selected.right.workerSessionId} at ${selected.right.cwd}.`,
                  },
                ],
                isError: false,
                details: { outcome: "selected", ...selected.right },
              }
        }
        const selected = managerTarget(ctx)
        if (Either.isLeft(selected)) return controlError(selected.left)
        if (params.action === "current")
          return {
            content: [
              {
                type: "text" as const,
                text: `Current worker: ${selected.right.workerSessionId} at ${selected.right.cwd}.`,
              },
            ],
            isError: false,
            details: { outcome: "selected", ...selected.right },
          }
        if (typeof params.order !== "string" || !params.order.trim())
          return controlError(
            new ManagerSessionError({
              code: "invalid_input",
              message:
                "Priorities require an explicit order of task IDs or clear.",
            }),
          )
        const state = client(ctx)
        if (Either.isLeft(state)) return controlError(state.left)
        const current = state.right.context()
        if (Either.isLeft(current)) return controlError(current.left)
        const queued = state.right.enqueuePriorities(
          params.order,
          current.right.priorityRevision,
        )
        if (Either.isLeft(queued)) return controlError(queued.left)
        submitted.add(queued.right)
        return {
          content: [
            {
              type: "text" as const,
              text: `Queued priority request ${queued.right}; worker completion is not confirmed.`,
            },
          ],
          isError: false,
          details: {
            outcome: "queued",
            requestId: queued.right,
            ...selected.right,
          },
        }
      },
    })
    controlRegistered = true
  }
  const resume = (ctx: ExtensionContext, mode: "restore" | "replace") => {
    activeSessionId = ctx.sessionManager.getSessionId()
    activeCtx = ctx
    stop()
    if (isManager()) {
      registerControl()
      pi.setActiveTools([...MANAGEMENT_TOOLS])
      pollManager(ctx)
      cancelPolling = runtime.schedule(() => pollManager(ctx))
      return
    }
    if (ctx.mode !== "tui") return
    const target = binding(ctx)
    if (Either.isLeft(target)) return
    const state = prepareNativeManagerState(
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
  pi.on("session_shutdown", () => {
    stop()
    activeSessionId = undefined
    activeCtx = undefined
    releaseBinding()
  })
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
  pi.on("tool_call", event => {
    if (!isManager()) return
    if (!MANAGEMENT_TOOLS.includes(event.toolName))
      return {
        block: true,
        reason:
          "Manager sessions permit management tools, not coding execution.",
      }
    if (
      event.toolName === "agent_registry" &&
      (!record(event.input) ||
        !Object.hasOwn(event.input, "action") ||
        (event.input.action !== "list" && event.input.action !== "requests"))
    )
      return {
        block: true,
        reason:
          "Manager sessions may read registry lists and reports, not mutate roles or request lifecycle.",
      }
  })

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
      const plan = globalManagerSessionLaunchPlan({
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
      const workspace = join(
        homedir(),
        ".config",
        "ai",
        "pi",
        "workspaces",
        "manager",
      )
      const ready = prepareGlobalWorkspace(workspace)
      if (Either.isLeft(ready)) {
        notice(ctx, ready.left)
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

const controlError = (error: ManagerSessionError) => ({
  content: [{ type: "text" as const, text: error.message }],
  isError: true,
  details: { outcome: error.code },
})
const prepareGlobalWorkspace = (
  directory: string,
): Either.Either<void, ManagerSessionError> =>
  Either.gen(function* () {
    yield* attempt(() => mkdirSync(directory, { recursive: true, mode: 0o700 }))
    const stat = yield* attempt(() => lstatSync(directory))
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      typeof process.getuid !== "function" ||
      stat.uid !== process.getuid()
    )
      return yield* failed(
        "unsafe_state",
        "Global manager workspace must be a private, owned directory.",
      )
    if ((stat.mode & 0o077) !== 0)
      yield* attempt(() => chmodSync(directory, 0o700))
  })

const MANAGEMENT_TOOLS: readonly string[] = [
  "agent_registry",
  "todo",
  "manager_control",
]
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
