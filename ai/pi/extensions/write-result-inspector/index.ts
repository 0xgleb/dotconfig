import type {
  BeforeAgentStartEvent,
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import {
  createMutationBatcher,
  type MutationBatcher,
  type MutationBatcherError,
} from "./batcher.ts"
import {
  mutationDeltaFromSuccessfulToolResult,
  type LoadedContextFile,
} from "./core.ts"
import {
  defaultDeterministicDependencies,
  runDeterministicChecks,
} from "./deterministic.ts"
import {
  inspectionResultPatch,
  runInspectionBatch,
  type InspectionRunResult,
} from "./inspection.ts"
import {
  runLunaInspector,
  type InspectorProcessDependencies,
} from "./inspector-process.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"

const BATCH_WINDOW_MS = 150

export interface InspectorHost {
  exec(
    command: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>
}

interface InspectorRuntimeState {
  readonly cwd: string
  readonly controller: AbortController
  contextFiles: LoadedContextFile[]
  turnSignal: AbortSignal | undefined
  parentProvider: string | undefined
}

export interface InspectorRuntime extends InspectorRuntimeState {
  readonly batcher: MutationBatcher<InspectionRunResult>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const contextFilesFrom = (event: BeforeAgentStartEvent): LoadedContextFile[] =>
  (event.systemPromptOptions.contextFiles ?? []).flatMap(file => {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    )
      return []
    return [{ path: file.path, content: file.content }]
  })

const combinedSignal = (
  sessionSignal: AbortSignal,
  turnSignal: AbortSignal | undefined,
): AbortSignal =>
  turnSignal ? AbortSignal.any([sessionSignal, turnSignal]) : sessionSignal

const processDependencies = (
  pi: InspectorHost,
  cwd: string,
  signal: AbortSignal,
): InspectorProcessDependencies => ({
  cwd,
  signal,
  exec: async (command, args, options) =>
    pi.exec(command, [...args], {
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: options.timeout,
    }),
})

export const createRuntime = (
  pi: InspectorHost,
  cwd: string,
): Effect.Effect<InspectorRuntime, MutationBatcherError> =>
  Effect.gen(function* () {
    const controller = new AbortController()
    const state: InspectorRuntimeState = {
      cwd,
      controller,
      contextFiles: [],
      turnSignal: undefined,
      parentProvider: undefined,
    }
    const batcher = yield* createMutationBatcher<InspectionRunResult>({
      windowMs: BATCH_WINDOW_MS,
      inspect: deltas => {
        const signal = combinedSignal(controller.signal, state.turnSignal)
        if (state.parentProvider === "ollama")
          return Promise.resolve({
            status: "skipped" as const,
            reason: "model-unavailable" as const,
            skipped: [],
          })
        return runInspectionBatch(deltas, {
          cwd,
          signal,
          contextFiles: state.contextFiles,
          deterministic: files =>
            runDeterministicChecks(
              files,
              defaultDeterministicDependencies(
                cwd,
                signal,
                (command, args, options) => pi.exec(command, args, options),
              ),
            ),
          luna: (prompt, files) =>
            runLunaInspector(
              prompt,
              files,
              processDependencies(pi, cwd, signal),
            ),
        })
      },
    })
    return Object.assign(state, { batcher })
  })

export const cancelRuntime = (runtime: InspectorRuntime | undefined): void => {
  if (!runtime) return
  runtime.controller.abort()
  runtime.batcher.cancel({
    status: "skipped",
    reason: "cancelled",
    skipped: [],
  })
}

export const inspectSuccessfulMutation = async (
  event: ToolResultEvent,
  runtime: InspectorRuntime,
): Promise<ReturnType<typeof inspectionResultPatch> | undefined> => {
  if (event.isError) return undefined
  const candidate = mutationDeltaFromSuccessfulToolResult({
    cwd: runtime.cwd,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
  })
  if (candidate.status !== "candidate") return undefined
  const delivery = await runtime.batcher.enqueue(candidate.delta)
  if (!delivery.leader || runtime.controller.signal.aborted) return undefined
  return inspectionResultPatch(
    {
      content: event.content,
      details: event.details,
      usage: event.usage,
    },
    delivery.result,
  )
}

export default (pi: ExtensionAPI): void => {
  registerRuntimeVersion(pi, "write-result-inspector", "2026.09.04.1")

  let runtime: InspectorRuntime | undefined

  pi.on("session_start", async (_event, ctx) => {
    cancelRuntime(runtime)
    const created = await Effect.runPromise(
      Effect.either(createRuntime(pi, ctx.cwd)),
    )
    if (Either.isLeft(created)) {
      runtime = undefined
      process.stderr.write(`[write-result-inspector] ${created.left.message}\n`)
      return
    }
    runtime = created.right
  })

  pi.on("before_agent_start", (event, ctx) => {
    if (!runtime || runtime.cwd !== ctx.cwd) return
    runtime.contextFiles = contextFilesFrom(event)
    runtime.parentProvider = ctx.model?.provider
  })

  pi.on("tool_result", async (event, ctx) => {
    const current = runtime
    if (!current || current.cwd !== ctx.cwd) return
    current.turnSignal = ctx.signal
    return inspectSuccessfulMutation(event, current)
  })

  pi.on("session_shutdown", () => {
    cancelRuntime(runtime)
    runtime = undefined
  })
}
