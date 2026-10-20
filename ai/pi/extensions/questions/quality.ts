import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Either } from "effect"
import { parseContentCritiqueResponse } from "../shared/content-critique-response.ts"
import {
  runContentProcess,
  type ContentProcessContext,
} from "../shared/content-process.ts"
import { contentCritiquePrompt } from "../shared/content-critique.ts"

/** Independent complete-coverage criticism is required before queueing questions. */
const QUESTION_JUDGE_INSTRUCTIONS_BUDGET = 6_000
const CONCRETE_MARKER = /(\d|\/|`[^`]+`|"[^"]+"|'[^']+'|\.[a-z]{2,4}\b)/i
const PROCESS_CONTINUATION =
  /\b(continue|proceed|carry on|keep going|go ahead)\b/i

export interface AskQualityInput {
  readonly question: string
  readonly header?: string
  readonly guess?: string
  readonly options?: readonly {
    readonly label: string
    readonly description?: string
  }[]
}
export type AskQualityVerdict = { readonly reason: string } & (
  | { readonly outcome: "admitted"; readonly admissible: true }
  | { readonly outcome: "rejected"; readonly admissible: false }
  | { readonly outcome: "review-unavailable"; readonly admissible: false }
)
export interface JudgeResponse {
  readonly admissible: boolean
  readonly reason: string
}
export interface AskQualityDeps {
  readonly runJudge?: (prompt: string) => Promise<JudgeResponse | undefined>
  readonly projectInstructions?: () => Promise<string | undefined>
}
export const structuralContextFreeDefects = (
  question: string,
): string | undefined =>
  PROCESS_CONTINUATION.test(question) && !CONCRETE_MARKER.test(question)
    ? "Context-free process question: it asks about continuing work without naming any artifact, path, number, interval, or quoted detail the user can see."
    : undefined

const describeOwnerVisibleQuestion = (input: AskQualityInput): string =>
  JSON.stringify({
    header: input.header,
    question: input.question,
    suggestedAnswer: input.guess,
    options: input.options,
  })
export const buildJudgePrompt = (
  input: AskQualityInput,
  instructions: string | undefined,
): string =>
  contentCritiquePrompt({
    purpose: "Decision question",
    audience: "The busy human owner, who has not necessarily read tool calls",
    objective:
      "The complete card must be answerable as written: concrete current behavior and problem, enough evidence and context to compare the proposals, meaningful tradeoffs and a clear boundary on what the answer authorizes. Review the question, suggestion and every option description together. Use specific proposals as choices where appropriate, without a quota of three. Preserve genuinely free-form decisions and do not demand details irrelevant to this choice.",
    draft: describeOwnerVisibleQuestion(input),
    ...(instructions === undefined ? {} : { guidance: instructions }),
  })

export const evaluateAskQuality = async (
  input: AskQualityInput,
  deps: AskQualityDeps,
): Promise<AskQualityVerdict> => {
  const structural = structuralContextFreeDefects(input.question)
  if (structural)
    return { outcome: "rejected", admissible: false, reason: structural }
  if (!deps.runJudge)
    return {
      outcome: "review-unavailable",
      admissible: false,
      reason: "No question critic is configured; no question queued.",
    }
  const instructions = await deps.projectInstructions?.()
  const verdict = await deps.runJudge(buildJudgePrompt(input, instructions))
  if (!verdict)
    return {
      outcome: "review-unavailable",
      admissible: false,
      reason:
        "Critic review unavailable; no complete review was returned. No question queued.",
    }
  return verdict.admissible
    ? { outcome: "admitted", admissible: true, reason: verdict.reason }
    : { outcome: "rejected", admissible: false, reason: verdict.reason }
}
const boundedProjectInstructions = async (
  cwd: string,
): Promise<string | undefined> => {
  try {
    const content = await readFile(join(cwd, "AGENTS.md"), "utf8")
    const trimmed = content.trim()
    return trimmed.length === 0
      ? undefined
      : trimmed.slice(0, QUESTION_JUDGE_INSTRUCTIONS_BUDGET)
  } catch {
    return undefined
  }
}

/** Compatibility export: existing loaded consumers retain this callable contract. */
export interface JudgeContext extends ContentProcessContext {}
export const parseJudgeResponse = (
  output: string,
): JudgeResponse | undefined => {
  const parsed = parseContentCritiqueResponse(output)
  return Either.isLeft(parsed)
    ? undefined
    : { admissible: parsed.right.admissible, reason: parsed.right.reason }
}
export const makeQuestionJudge =
  (ctx: JudgeContext) =>
  async (prompt: string): Promise<JudgeResponse | undefined> => {
    const output = await runContentProcess(ctx, { role: "critic", prompt })
    if (output === undefined) return undefined
    const parsed = parseContentCritiqueResponse(output, "verdict-json")
    return Either.isRight(parsed)
      ? { admissible: parsed.right.admissible, reason: parsed.right.reason }
      : undefined
  }
export const askQualityDepsFor = (ctx: JudgeContext): AskQualityDeps => ({
  runJudge: makeQuestionJudge(ctx),
  projectInstructions: () => boundedProjectInstructions(ctx.cwd),
})
