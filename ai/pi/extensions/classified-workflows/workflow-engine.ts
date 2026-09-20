import vm from "node:vm"
import { Data, Effect, Either } from "effect"
import {
  availableMemoryBytes as systemAvailableMemoryBytes,
  type MemoryCapacityError,
} from "../shared/memory-capacity.ts"

export interface AgentRequest {
  task: string
  cwd?: string
  tools?: string[] | string
  model?: string
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  schema?: unknown
}

export type AgentOptions = Omit<AgentRequest, "task">

const MAX_AGENT_TOOLS = 16
const MAX_AGENT_TOOL_NAME_CHARACTERS = 64

export class WorkflowScriptError extends Data.TaggedError(
  "WorkflowScriptError",
)<{
  readonly message: string
}> {}

const workflowFailure = (message: string): WorkflowScriptError =>
  new WorkflowScriptError({ message })

const failWorkflow = (message: string): Promise<never> =>
  Effect.runPromise(Effect.fail(workflowFailure(message)))

const failWorkflowCause = (cause: unknown): Promise<never> =>
  Effect.runPromise(Effect.fail(cause))

export const normalizeAgentTools = (
  value: unknown,
): Effect.Effect<string[] | undefined, WorkflowScriptError> => {
  if (value === undefined) return Effect.succeed(undefined)
  const tools =
    typeof value === "string"
      ? value.split(",").map(tool => tool.trim())
      : value
  return !Array.isArray(tools) ||
    tools.length === 0 ||
    tools.length > MAX_AGENT_TOOLS ||
    tools.some(
      tool =>
        typeof tool !== "string" ||
        tool.length === 0 ||
        tool.length > MAX_AGENT_TOOL_NAME_CHARACTERS,
    )
    ? Effect.fail(
        workflowFailure(
          "agent tools must be a non-empty array or comma-delimited string of bounded tool names",
        ),
      )
    : Effect.succeed(tools)
}

export type AgentResult =
  | {
      status: "completed"
      output: string
      usageTokens: number
      diagnostic?: string
    }
  | {
      status: "blocked" | "failed" | "timed-out"
      output: ""
      reason: string
      usageTokens: number
    }

/** Cumulative process-observed usage for one attempt, not provider billing. */
export type AgentUsageObserver = (usageTokens: number) => void

export interface WorkflowLimits {
  maxAgents: number
  concurrency: number
  agentTimeoutMs: number
  workflowTimeoutMs: number
  retries: number
  tokenBudget: number
}

export interface WorkflowDependencies {
  prepareAgentRequest?: (
    request: AgentRequest,
  ) => Effect.Effect<AgentRequest, unknown>
  runAgent(
    request: AgentRequest,
    signal: AbortSignal,
    tokenLimit: number,
    onUsage?: AgentUsageObserver,
  ): Promise<AgentResult>
  checkpoint(message: string): Promise<"approved" | "denied">
  phase?: (title: string) => void
  log?: (message: string) => void
  availableMemoryBytes?: () => number
}

export const MIN_AGENT_TOKEN_RESERVATION = 4_000
export const MIN_CLASSIFIED_AGENT_TIMEOUT_MS = 180_000
export const MIN_WORKFLOW_FREE_MEMORY_BYTES = 8 * 1024 ** 3
export const WORKFLOW_AGENT_MEMORY_RESERVATION_BYTES = 2 * 1024 ** 3
const MAX_WORKFLOW_PHASES = 16
const RETRY_BACKOFF_BASE_MS = 500
const RETRY_BACKOFF_MAX_MS = 5_000
const isNonRetryableBudgetFailure = (result: AgentResult): boolean =>
  result.status === "failed" &&
  /Minimum child allocation is \d+ tokens/i.test(result.reason)

const validateStructuredValue = (
  value: unknown,
  schema: unknown,
  path = "$",
): Effect.Effect<void, WorkflowScriptError> =>
  Effect.gen(function* () {
    if (!isRecord(schema))
      return yield* Effect.fail(
        workflowFailure("agent schema must be a JSON Schema object"),
      )
    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some(candidate => Object.is(candidate, value))
    )
      return yield* Effect.fail(
        workflowFailure(`structured agent output violates enum at ${path}`),
      )
    if (schema.type === "object") {
      if (!isRecord(value))
        return yield* Effect.fail(
          workflowFailure(
            `structured agent output requires an object at ${path}`,
          ),
        )
      for (const key of Array.isArray(schema.required) ? schema.required : []) {
        if (typeof key !== "string" || !(key in value))
          return yield* Effect.fail(
            workflowFailure(
              `structured agent output is missing ${path}.${String(key)}`,
            ),
          )
      }
      if (isRecord(schema.properties))
        for (const [key, child] of Object.entries(schema.properties))
          if (key in value)
            yield* validateStructuredValue(value[key], child, `${path}.${key}`)
      return
    }
    if (schema.type === "array") {
      if (!Array.isArray(value))
        return yield* Effect.fail(
          workflowFailure(
            `structured agent output requires an array at ${path}`,
          ),
        )
      if (schema.items !== undefined)
        for (const [index, item] of value.entries())
          yield* validateStructuredValue(
            item,
            schema.items,
            `${path}[${index}]`,
          )
      return
    }
    const invalidType =
      schema.type === "string" && typeof value !== "string"
        ? "string"
        : schema.type === "integer" && !Number.isInteger(value)
          ? "integer"
          : schema.type === "number" && typeof value !== "number"
            ? "number"
            : schema.type === "boolean" && typeof value !== "boolean"
              ? "boolean"
              : undefined
    if (invalidType)
      return yield* Effect.fail(
        workflowFailure(
          `structured agent output requires a ${invalidType} at ${path}`,
        ),
      )
  })

const parseStructuredAgentOutput = (
  output: string,
  schema: unknown,
): Effect.Effect<unknown, WorkflowScriptError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(output.trim()),
      catch: () =>
        workflowFailure("structured agent output was not valid JSON"),
    })
    yield* validateStructuredValue(parsed, schema)
    return parsed
  })

const structuredRepairRequest = (
  request: AgentRequest,
  reason: string,
): AgentRequest => {
  const instruction =
    `Your prior structured output failed validation: ${reason.slice(0, 240)}. ` +
    "Return one replacement JSON value that strictly satisfies the same schema. Do not add prose or markdown.\n\n"
  return {
    ...request,
    task: `${instruction}${request.task.slice(0, Math.max(0, 32_000 - instruction.length))}`,
  }
}

export async function runWorkflowScript(
  code: string,
  limits: WorkflowLimits,
  dependencies: WorkflowDependencies,
  signal?: AbortSignal,
): Promise<unknown> {
  await Effect.runPromise(validateLimits(limits))
  const workflowController = new AbortController()
  const abortWithWorkflowFailure = (message: string): void =>
    workflowController.abort(workflowFailure(message))
  const abortWorkflow = () => workflowController.abort(signal?.reason)
  if (signal?.aborted) abortWorkflow()
  else signal?.addEventListener("abort", abortWorkflow, { once: true })

  let phaseAgentCount = 0
  let phaseCount = 0
  let inFlightAgentCalls = 0
  let usedTokens = 0
  let reservedTokens = 0
  const perAgentTokenLimit = Math.floor(limits.tokenBudget / limits.maxAgents)
  let activeAgents = 0
  const waiters: Array<() => void> = []
  let tokenReservationScheduled = false
  let pendingTokenReservations: Array<{
    resolve: (tokenLimit: number) => void
    reject: (error: Error) => void
  }> = []

  const scheduleTokenReservationFlush = (): void => {
    if (tokenReservationScheduled || pendingTokenReservations.length === 0)
      return
    tokenReservationScheduled = true
    queueMicrotask(flushTokenReservations)
  }

  const flushTokenReservations = (): void => {
    tokenReservationScheduled = false
    while (pendingTokenReservations.length > 0) {
      const availableTokens = Math.max(
        0,
        limits.tokenBudget - usedTokens - reservedTokens,
      )
      const remainingPhaseSlots = Math.max(
        0,
        limits.maxAgents - phaseAgentCount,
      )
      const futureMinimumReserve =
        remainingPhaseSlots * MIN_AGENT_TOKEN_RESERVATION
      const pendingWaveShare = Math.floor(
        Math.max(0, availableTokens - futureMinimumReserve) /
          pendingTokenReservations.length,
      )
      const agentTokenLimit = Math.min(
        Math.max(perAgentTokenLimit, pendingWaveShare),
        availableTokens,
      )
      if (agentTokenLimit < perAgentTokenLimit && reservedTokens > 0) {
        return
      }
      if (agentTokenLimit < MIN_AGENT_TOKEN_RESERVATION) {
        const pending = pendingTokenReservations
        pendingTokenReservations = []
        const error = new Error(
          `Workflow token budget cannot start ${pending.length === 1 ? "another agent" : `${pending.length} pending agents`}: ` +
            `${availableTokens} tokens remain; minimum child reservation is ${MIN_AGENT_TOKEN_RESERVATION}`,
        )
        for (const reservation of pending) reservation.reject(error)
        return
      }
      const reservation = pendingTokenReservations.shift()
      if (!reservation) return
      reservedTokens += agentTokenLimit
      reservation.resolve(agentTokenLimit)
    }
  }

  const reserveAgentTokens = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      pendingTokenReservations.push({ resolve, reject })
      scheduleTokenReservationFlush()
    })

  const acquire = async () => {
    if (activeAgents < limits.concurrency) {
      activeAgents += 1
      return
    }
    await new Promise<void>(resolve => waiters.push(resolve))
    activeAgents += 1
  }

  const release = () => {
    activeAgents -= 1
    waiters.shift()?.()
  }

  const runOnce = async (
    request: AgentRequest,
    tokenLimit: number,
  ): Promise<AgentResult> => {
    await acquire()
    const controller = new AbortController()
    let observedUsageTokens = 0
    let observationState: "open" | "closed" = "open"
    const onUsage: AgentUsageObserver = usageTokens => {
      if (observationState === "closed" || controller.signal.aborted) return
      if (
        !Number.isSafeInteger(usageTokens) ||
        usageTokens < observedUsageTokens
      ) {
        controller.abort(workflowFailure("Invalid agent usage observation"))
        return
      }
      observedUsageTokens = usageTokens
    }
    const failedAttempt = (error: unknown): AgentResult => {
      const reason = error instanceof Error ? error.message : "Agent failed"
      return {
        status: /timed out/i.test(reason) ? "timed-out" : "failed",
        output: "",
        reason,
        usageTokens: observedUsageTokens,
      }
    }
    const abortAgent = () => controller.abort(workflowController.signal.reason)
    workflowController.signal.addEventListener("abort", abortAgent, {
      once: true,
    })
    const timer = setTimeout(
      () => controller.abort(new Error("Agent timed out")),
      limits.agentTimeoutMs,
    )
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () =>
        reject(controller.signal.reason ?? new Error("Agent aborted"))
      if (controller.signal.aborted) rejectAbort()
      else
        controller.signal.addEventListener("abort", rejectAbort, { once: true })
    })
    try {
      const result = await Promise.race([
        dependencies.runAgent(request, controller.signal, tokenLimit, onUsage),
        aborted,
      ])
      if (workflowController.signal.aborted)
        return failWorkflowCause(workflowController.signal.reason)
      if (controller.signal.aborted)
        return failedAttempt(controller.signal.reason)
      if (
        !Number.isSafeInteger(result.usageTokens) ||
        result.usageTokens < observedUsageTokens
      )
        return failedAttempt(workflowFailure("Invalid agent usage result"))
      return result
    } catch (error) {
      if (workflowController.signal.aborted) return failWorkflowCause(error)
      return failedAttempt(error)
    } finally {
      observationState = "closed"
      clearTimeout(timer)
      workflowController.signal.removeEventListener("abort", abortAgent)
      release()
    }
  }

  const agent = async (
    requestOrTask: AgentRequest | string,
    options?: AgentOptions,
  ): Promise<unknown> => {
    if (options !== undefined && !isRecord(options))
      return failWorkflow("agent options must be an object")
    const rawRequest: AgentRequest =
      typeof requestOrTask === "string"
        ? {
            task: requestOrTask,
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options?.tools === undefined ? {} : { tools: options.tools }),
            ...(options?.model === undefined ? {} : { model: options.model }),
            ...(options?.thinking === undefined
              ? {}
              : { thinking: options.thinking }),
            ...(options?.schema === undefined
              ? {}
              : { schema: options.schema }),
          }
        : requestOrTask
    if (
      !rawRequest ||
      typeof rawRequest.task !== "string" ||
      rawRequest.task.trim() === ""
    )
      return failWorkflow("agent requires a non-empty task")
    const clonedRequest = structuredClone(rawRequest)
    const { tools, ...requestWithoutTools } = clonedRequest
    const normalizedToolsResult = Effect.runSync(
      Effect.either(normalizeAgentTools(tools)),
    )
    if (Either.isLeft(normalizedToolsResult))
      return failWorkflow(normalizedToolsResult.left.message)
    const normalizedTools = normalizedToolsResult.right
    const normalizedRequest: AgentRequest =
      normalizedTools === undefined
        ? requestWithoutTools
        : { ...requestWithoutTools, tools: normalizedTools }
    const preparedResult = dependencies.prepareAgentRequest
      ? Effect.runSync(
          Effect.either(dependencies.prepareAgentRequest(normalizedRequest)),
        )
      : Either.right(normalizedRequest)
    if (Either.isLeft(preparedResult))
      return failWorkflowCause(preparedResult.left)
    const request = preparedResult.right
    if (request.task.length > 32_000)
      return failWorkflow("agent tasks may contain at most 32,000 characters")
    if (request.schema !== undefined) {
      if (!isRecord(request.schema))
        return failWorkflow("agent schema must be a JSON Schema object")
      const encodedSchema = await Effect.runPromise(
        Effect.try({
          try: () => JSON.stringify(request.schema),
          catch: () =>
            workflowFailure("agent schema must be JSON serializable"),
        }),
      )
      if (encodedSchema.length > 16_000)
        return failWorkflow(
          "agent schema may contain at most 16,000 characters",
        )
    }
    if (phaseAgentCount >= limits.maxAgents)
      return failWorkflow(
        `Workflow phase agent limit exceeded (${limits.maxAgents}); start a new named phase only after current children settle`,
      )
    inFlightAgentCalls += 1
    const memoryProbe: Effect.Effect<
      number,
      WorkflowScriptError | MemoryCapacityError
    > = dependencies.availableMemoryBytes
      ? Effect.try({
          try: dependencies.availableMemoryBytes,
          catch: cause =>
            workflowFailure(
              cause instanceof Error
                ? cause.message
                : "Workflow memory probe failed",
            ),
        })
      : Effect.map(systemAvailableMemoryBytes(), Number)
    const availableMemoryResult = await Effect.runPromise(
      Effect.either(memoryProbe),
    )
    if (Either.isLeft(availableMemoryResult)) {
      inFlightAgentCalls -= 1
      return failWorkflowCause(availableMemoryResult.left)
    }
    const availableMemory = availableMemoryResult.right
    const requiredMemory =
      MIN_WORKFLOW_FREE_MEMORY_BYTES +
      activeAgents * WORKFLOW_AGENT_MEMORY_RESERVATION_BYTES
    if (!Number.isFinite(availableMemory) || availableMemory < requiredMemory) {
      const availableGiB = Number.isFinite(availableMemory)
        ? (availableMemory / 1024 ** 3).toFixed(1)
        : "unknown"
      const requiredGiB = (requiredMemory / 1024 ** 3).toFixed(1)
      inFlightAgentCalls -= 1
      return failWorkflow(
        `Workflow memory reserve cannot start another agent: ${availableGiB} GiB available; ${requiredGiB} GiB required for the crash reserve and ${activeAgents} active agent(s)`,
      )
    }
    phaseAgentCount += 1
    let agentTokenLimit: number
    try {
      agentTokenLimit = await reserveAgentTokens()
    } catch (error) {
      inFlightAgentCalls -= 1
      return failWorkflowCause(error)
    }

    let result: AgentResult | undefined
    let agentUsageTokens = 0
    try {
      for (let attempt = 0; attempt <= limits.retries; attempt += 1) {
        if (workflowController.signal.aborted)
          return failWorkflow("Workflow aborted")
        try {
          const remainingAgentTokens = Math.max(
            0,
            agentTokenLimit - agentUsageTokens,
          )
          if (remainingAgentTokens < MIN_AGENT_TOKEN_RESERVATION) {
            result = {
              status: "failed",
              output: "",
              reason: `Agent token budget exhausted (${agentUsageTokens}/${agentTokenLimit})`,
              usageTokens: 0,
            }
            break
          }
          result = await runOnce(request, remainingAgentTokens)
          agentUsageTokens += Math.max(0, result.usageTokens)
          if (
            result.status === "completed" ||
            result.status === "blocked" ||
            isNonRetryableBudgetFailure(result)
          )
            break
          if (attempt < limits.retries) {
            await retryBackoff(attempt, workflowController.signal)
          }
        } catch (error) {
          if (workflowController.signal.aborted) return failWorkflowCause(error)
          if (attempt >= limits.retries) {
            const reason =
              error instanceof Error ? error.message : "Agent failed"
            result = {
              status: /timed out/i.test(reason) ? "timed-out" : "failed",
              output: "",
              reason,
              usageTokens: 0,
            }
            break
          }
          await retryBackoff(attempt, workflowController.signal)
        }
      }

      if (!result) return failWorkflow("Agent produced no result")
      const measuredResult: AgentResult =
        agentUsageTokens > agentTokenLimit
          ? {
              status: "failed",
              output: "",
              reason: `Agent exceeded token limit (${agentUsageTokens}/${agentTokenLimit})`,
              usageTokens: agentUsageTokens,
            }
          : { ...result, usageTokens: agentUsageTokens }
      if (request.schema === undefined) return measuredResult
      if (measuredResult.status === "blocked") return measuredResult
      if (measuredResult.status !== "completed")
        return failWorkflow(
          `structured agent ${measuredResult.status}: ${measuredResult.reason ?? "no result"}`,
        )
      try {
        return await Effect.runPromise(
          parseStructuredAgentOutput(measuredResult.output, request.schema),
        )
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : "structured agent output failed validation"
        const remainingTokens = Math.max(0, agentTokenLimit - agentUsageTokens)
        if (remainingTokens < MIN_AGENT_TOKEN_RESERVATION)
          return failWorkflowCause(error)
        const repair = await runOnce(
          structuredRepairRequest(request, reason),
          remainingTokens,
        )
        agentUsageTokens += Math.max(0, repair.usageTokens)
        if (agentUsageTokens > agentTokenLimit)
          return failWorkflow(
            `structured agent repair exceeded token limit (${agentUsageTokens}/${agentTokenLimit})`,
          )
        if (repair.status !== "completed")
          return failWorkflow(
            `structured agent repair ${repair.status}: ${repair.reason ?? "no result"}`,
          )
        try {
          return await Effect.runPromise(
            parseStructuredAgentOutput(repair.output, request.schema),
          )
        } catch (repairError) {
          const repairReason =
            repairError instanceof Error
              ? repairError.message
              : "structured agent output failed validation"
          return failWorkflow(
            `structured agent output remained invalid after one bounded repair: ${repairReason}`,
          )
        }
      }
    } finally {
      usedTokens += agentUsageTokens
      reservedTokens -= agentTokenLimit
      inFlightAgentCalls -= 1
      scheduleTokenReservationFlush()
    }
  }

  const parallel = async <T>(
    tasks: Array<PromiseLike<T> | (() => PromiseLike<T>)>,
  ): Promise<T[]> => {
    if (
      !Array.isArray(tasks) ||
      tasks.some(task => typeof task !== "function" && !isPromiseLike(task))
    )
      return failWorkflow("parallel requires an array of promises or functions")
    return Promise.all(
      tasks.map(task => (typeof task === "function" ? task() : task)),
    )
  }

  const checkpoint = async (message: string): Promise<void> => {
    if (typeof message !== "string" || message.trim() === "")
      return failWorkflow("checkpoint requires a message")
    if ((await dependencies.checkpoint(message)) !== "approved")
      return failWorkflow(`Checkpoint denied: ${message}`)
  }

  const phase = (title: string): void => {
    if (typeof title !== "string" || title.trim() === "" || title.length > 80) {
      abortWithWorkflowFailure(
        "phase requires a non-empty title of at most 80 characters",
      )
      return
    }
    if (inFlightAgentCalls > 0) {
      abortWithWorkflowFailure(
        `Workflow cannot change phase while ${inFlightAgentCalls} agent call(s) are still active`,
      )
      return
    }
    if (phaseCount >= MAX_WORKFLOW_PHASES) {
      abortWithWorkflowFailure(
        `Workflow may use at most ${MAX_WORKFLOW_PHASES} named phases`,
      )
      return
    }
    phaseCount += 1
    phaseAgentCount = 0
    dependencies.phase?.(title)
  }

  const log = (message: string): void => {
    if (
      typeof message !== "string" ||
      message.trim() === "" ||
      message.length > 2_000
    ) {
      abortWithWorkflowFailure(
        "log requires a non-empty message of at most 2,000 characters",
      )
      return
    }
    dependencies.log?.(message)
  }

  const context = vm.createContext(
    {
      agent,
      parallel,
      checkpoint,
      phase,
      log,
      Date: undefined,
      process: undefined,
      require: undefined,
      fetch: undefined,
      console: undefined,
    },
    { codeGeneration: { strings: false, wasm: false } },
  )
  const deterministicMath = new vm.Script(
    `Object.defineProperty(Math, "random", {
       value: undefined,
       writable: false,
       configurable: false
     });
     Object.freeze(Math);`,
  )
  deterministicMath.runInContext(context, { timeout: 100 })
  const script = new vm.Script(`(async () => { "use strict"; ${code}\n})()`)
  const workflow: Promise<unknown> = script.runInContext(context, {
    timeout: 1_000,
  })
  const timer = setTimeout(
    () => workflowController.abort(new Error("Workflow timed out")),
    limits.workflowTimeoutMs,
  )
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () =>
      reject(workflowController.signal.reason ?? new Error("Workflow aborted"))
    if (workflowController.signal.aborted) rejectAbort()
    else
      workflowController.signal.addEventListener("abort", rejectAbort, {
        once: true,
      })
  })

  try {
    const result = await Promise.race([workflow, aborted])
    return result === undefined ? undefined : structuredClone(result)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abortWorkflow)
  }
}

const retryBackoff: (
  attempt: number,
  signal: AbortSignal,
) => Promise<void> = async (attempt, signal) => {
  const delayMs = Math.min(
    RETRY_BACKOFF_BASE_MS * 2 ** attempt,
    RETRY_BACKOFF_MAX_MS,
  )
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error("Workflow aborted"))
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function"
}

export const minimumRetryEnvelopeMs: (
  agentTimeoutMs: number,
  retries: number,
) => number = (agentTimeoutMs, retries) =>
  agentTimeoutMs * (retries + 1) +
  Array.from({ length: retries }, (_unused, attempt) =>
    Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_MAX_MS),
  ).reduce((total, delayMs) => total + delayMs, 0)

const validateLimits = (
  limits: WorkflowLimits,
): Effect.Effect<void, WorkflowScriptError> =>
  Effect.gen(function* () {
    const positive = [
      limits.maxAgents,
      limits.concurrency,
      limits.agentTimeoutMs,
      limits.workflowTimeoutMs,
      limits.tokenBudget,
    ]
    if (positive.some(value => !Number.isInteger(value) || value <= 0))
      return yield* Effect.fail(
        workflowFailure("Workflow limits must be positive integers"),
      )
    if (!Number.isInteger(limits.retries) || limits.retries < 0)
      return yield* Effect.fail(
        workflowFailure("Workflow retries must be a non-negative integer"),
      )
    if (limits.concurrency > limits.maxAgents)
      return yield* Effect.fail(
        workflowFailure("Workflow concurrency cannot exceed the agent limit"),
      )
    const perAgentTokenLimit = Math.floor(limits.tokenBudget / limits.maxAgents)
    if (perAgentTokenLimit < MIN_AGENT_TOKEN_RESERVATION)
      return yield* Effect.fail(
        workflowFailure(
          `Workflow token budget minimum reservation is ${MIN_AGENT_TOKEN_RESERVATION} tokens per configured agent; ${perAgentTokenLimit} available`,
        ),
      )
    const retryEnvelopeMs = minimumRetryEnvelopeMs(
      limits.agentTimeoutMs,
      limits.retries,
    )
    if (limits.workflowTimeoutMs < retryEnvelopeMs) {
      const retryBackoffMs =
        retryEnvelopeMs - limits.agentTimeoutMs * (limits.retries + 1)
      return yield* Effect.fail(
        workflowFailure(
          `Workflow timeout ${limits.workflowTimeoutMs}ms cannot fit one agent's retry envelope of ${retryEnvelopeMs}ms; ` +
            `the envelope includes ${retryBackoffMs}ms retry backoff. Increase workflowTimeoutMs to at least ` +
            `${retryEnvelopeMs}ms or reduce agentTimeoutMs or retries.`,
        ),
      )
    }
  })
