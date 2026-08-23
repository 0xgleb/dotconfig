const OUTPUT_TOKEN_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
] as const
// Match Pi's estimateTextTokens contract in @earendil-works/pi-ai.
const TOKEN_ESTIMATE_CHARACTERS = 4
const TOKEN_ACCOUNTING_RESERVE = 512
const MIN_CHILD_OUTPUT_TOKENS = 1_024
const FINAL_SYNTHESIS_PROMPT_MULTIPLIER = 3
const MAX_WORKFLOW_CHILD_TOKEN_LIMIT = 5_000_000
// Live provider payloads have required up to 53,637 tokens before a child can
// return a usable synthesis. Keep one stable envelope above that observed
// boundary so impossible small grants fail before any child process starts.
export const MIN_EXECUTABLE_WORKFLOW_CHILD_TOKENS = 64_000
const NON_BILLABLE_PROVIDER_PAYLOAD_FIELDS = new Set([
  "include",
  "max_completion_tokens",
  "max_output_tokens",
  "max_tokens",
  "parallel_tool_calls",
  "prompt_cache_key",
  "store",
  "stream",
  "tool_choice",
])

export const WORKFLOW_CHILD_TOKEN_LIMIT_ENV =
  "PI_INTERNAL_WORKFLOW_CHILD_TOKEN_LIMIT"

export interface CappedProviderPayload {
  readonly payload: Readonly<Record<string, unknown>>
  readonly estimatedPromptTokens: number
  readonly outputTokenLimit: number
  readonly enforcement: "provider" | "process-measured"
  readonly finalResponseRequired: boolean
}

export interface ProviderTokenCapOptions {
  readonly allowProcessMeasuredOutput?: boolean
  readonly consumedTokens?: number
}

export const assertExecutableWorkflowBudget = (
  tokenBudget: number,
  maxAgents: number,
): void => {
  if (
    !Number.isSafeInteger(tokenBudget) ||
    tokenBudget < 1 ||
    !Number.isSafeInteger(maxAgents) ||
    maxAgents < 1
  )
    throw new Error("Workflow token budget envelope is malformed")
  const availablePerAgent = Math.floor(tokenBudget / maxAgents)
  if (availablePerAgent < MIN_EXECUTABLE_WORKFLOW_CHILD_TOKENS)
    throw new Error(
      `Workflow token budget cannot launch: minimum executable allocation is ${MIN_EXECUTABLE_WORKFLOW_CHILD_TOKENS} tokens per configured agent; ${availablePerAgent} available. Increase tokenBudget to at least ${MIN_EXECUTABLE_WORKFLOW_CHILD_TOKENS * maxAgents} or reduce maxAgents.`,
    )
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const promptBearingPayload = (
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(payload).filter(
      ([field]) => !NON_BILLABLE_PROVIDER_PAYLOAD_FIELDS.has(field),
    ),
  )

export const workflowChildTokenLimit = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_WORKFLOW_CHILD_TOKEN_LIMIT
  ) {
    throw new Error("Workflow child token environment limit is malformed")
  }
  return parsed
}

export const capProviderOutputTokens = (
  payload: unknown,
  tokenLimit: number,
  options: ProviderTokenCapOptions = {},
): CappedProviderPayload => {
  if (!isRecord(payload))
    throw new Error("Workflow child provider payload is malformed")
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1) {
    throw new Error("Workflow child token limit is malformed")
  }
  const consumedTokens = options.consumedTokens ?? 0
  if (!Number.isSafeInteger(consumedTokens) || consumedTokens < 0) {
    throw new Error("Workflow child consumed-token count is malformed")
  }
  const encoded = JSON.stringify(promptBearingPayload(payload))
  const estimatedPromptTokens = Math.ceil(
    encoded.length / TOKEN_ESTIMATE_CHARACTERS,
  )
  const availableOutputTokens =
    tokenLimit - estimatedPromptTokens - TOKEN_ACCOUNTING_RESERVE
  if (availableOutputTokens < MIN_CHILD_OUTPUT_TOKENS) {
    const minimumChildAllocation =
      consumedTokens +
      estimatedPromptTokens +
      TOKEN_ACCOUNTING_RESERVE +
      MIN_CHILD_OUTPUT_TOKENS
    throw new Error(
      `Workflow child prompt estimate leaves no usable synthesis budget ` +
        `(${estimatedPromptTokens}+${TOKEN_ACCOUNTING_RESERVE}+${MIN_CHILD_OUTPUT_TOKENS}/${tokenLimit} remaining; ${consumedTokens} already used). ` +
        `Minimum child allocation is ${minimumChildAllocation} tokens; increase workflow tokenBudget or reduce ` +
        `maxAgents/current fan-out so this child receives at least ${minimumChildAllocation} tokens.`,
    )
  }
  const finalResponseRequired =
    Array.isArray(payload.tools) &&
    payload.tools.length > 0 &&
    Object.hasOwn(payload, "tool_choice") &&
    payload.tool_choice !== "none" &&
    tokenLimit <
      estimatedPromptTokens * FINAL_SYNTHESIS_PROMPT_MULTIPLIER +
        TOKEN_ACCOUNTING_RESERVE
  const boundedPayload = finalResponseRequired
    ? { ...payload, tool_choice: "none" }
    : payload
  const field = OUTPUT_TOKEN_FIELDS.find(candidate =>
    Object.hasOwn(payload, candidate),
  )
  if (!field) {
    if (!options.allowProcessMeasuredOutput) {
      throw new Error(
        "Workflow child provider payload has no recognized output-token field",
      )
    }
    return {
      payload: boundedPayload,
      estimatedPromptTokens,
      outputTokenLimit: availableOutputTokens,
      enforcement: "process-measured",
      finalResponseRequired,
    }
  }
  const configured = payload[field]
  if (
    typeof configured !== "number" ||
    !Number.isSafeInteger(configured) ||
    configured < 1
  ) {
    throw new Error(`Workflow child provider payload ${field} is malformed`)
  }
  const outputTokenLimit = Math.min(configured, availableOutputTokens)
  return {
    payload: { ...boundedPayload, [field]: outputTokenLimit },
    estimatedPromptTokens,
    outputTokenLimit,
    enforcement: "provider",
    finalResponseRequired,
  }
}
