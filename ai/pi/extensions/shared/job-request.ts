import { Data, Schema } from "effect"
import { JobId } from "./job-attempt.ts"

// The immutable half of the job contract from SPEC "Jobs and worker pools" and
// ADR 01: a job is a bounded execution request whose prompt, RESOLVED execution
// metadata, allowed tools, and allocated budget are frozen at submission so
// execution, recovery, and audit never re-derive them.
//
// Traceability to the current classified-workflows invocation surface this
// replaces (issue #32: "jobs carrying the existing invocation metadata"):
// - AgentRequest.task -> prompt (bounded for a durable record; workflows only
//   bounded it indirectly through the 100_000-character code envelope)
// - AgentRequest.tools -> allowedTools, but RESOLVED: the engine accepted a
//   comma-delimited string or left tools inherited; a preserved request names
//   a concrete non-empty set with the same per-name and per-set bounds
// - AgentRequest.model/thinking -> execution.model/execution.reasoning as
//   concrete values; "omit to inherit the session model" is a submitting-side
//   choice that must be resolved before the request is frozen
// - AgentRequest.cwd -> execution.cwd resolved to an absolute path
// - workflow tokenBudget/agentTimeoutMs/retries -> budget fields with the same
//   numeric bounds (MIN_CLASSIFIED_AGENT_TIMEOUT_MS, token envelope bounds)
// - workflow code, maxAgents, concurrency, workflowTimeoutMs, background, and
//   label stay OUT: the coordinating agent submits subsequent jobs itself,
//   concurrency belongs to pool dispatch, and labels are presentation
// - AgentRequest.schema (structured output) stays an execution-layer concern
//
// This module owns only the value contract. Admission and authority
// enforcement, persistence transactions, worker dispatch, shutdown handling,
// and SDK hosting are separate owners, and nothing here activates a pool.
export const MAX_JOB_TOOLS = 16
export const MAX_JOB_TOOL_NAME_CHARACTERS = 64
export const MAX_JOB_PROMPT_CHARACTERS = 20_000
export const MAX_JOB_CWD_CHARACTERS = 4_096
export const MAX_JOB_MODEL_CHARACTERS = 200
export const MIN_JOB_TOKEN_BUDGET = 4_000
export const MAX_JOB_TOKEN_BUDGET = 5_000_000
export const MIN_JOB_TIMEOUT_MS = 180_000
export const MAX_JOB_TIMEOUT_MS = 900_000
export const MAX_JOB_RETRIES = 3

const Counter = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

const ToolName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_JOB_TOOL_NAME_CHARACTERS),
)
const allowedToolsMessage =
  "allowed tools must be a resolved, duplicate-free, non-empty set of bounded tool names"
const AllowedTools = Schema.Array(ToolName)
  .pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_JOB_TOOLS),
    Schema.filter(tools => new Set(tools).size === tools.length),
  )
  .annotations({ message: () => allowedToolsMessage })

const ReasoningEffort = Schema.Literal(
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
)

export const JobExecutionMetadata = Schema.Struct({
  cwd: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_JOB_CWD_CHARACTERS),
    Schema.pattern(/^\//),
  ),
  model: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_JOB_MODEL_CHARACTERS),
  ),
  reasoning: ReasoningEffort,
})
export type JobExecutionMetadata = typeof JobExecutionMetadata.Type

export const JobBudget = Schema.Struct({
  tokenBudget: Counter.pipe(
    Schema.greaterThanOrEqualTo(MIN_JOB_TOKEN_BUDGET),
    Schema.lessThanOrEqualTo(MAX_JOB_TOKEN_BUDGET),
  ),
  timeoutMs: Counter.pipe(
    Schema.greaterThanOrEqualTo(MIN_JOB_TIMEOUT_MS),
    Schema.lessThanOrEqualTo(MAX_JOB_TIMEOUT_MS),
  ),
  retries: Counter.pipe(Schema.lessThanOrEqualTo(MAX_JOB_RETRIES)),
})
export type JobBudget = typeof JobBudget.Type

export const JobRequest = Schema.Struct({
  version: Schema.Literal(1),
  jobId: JobId,
  prompt: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_JOB_PROMPT_CHARACTERS),
  ),
  allowedTools: AllowedTools,
  execution: JobExecutionMetadata,
  budget: JobBudget,
})
export type JobRequest = typeof JobRequest.Type

export class JobRequestError extends Data.TaggedError("JobRequestError")<{
  readonly code: "malformed"
}> {}

// The only planned entry point signature. Decoding is the boundary:
// everything that passes is a deeply frozen value, and everything that fails
// is a typed error. Callers resolve model, reasoning, cwd, and tools BEFORE
// decoding; the decoder never invents defaults, inherits session settings, or
// trims input.
export type DecodeJobRequest = (
  input: unknown,
) => import("effect").Effect.Effect<JobRequest, JobRequestError>
