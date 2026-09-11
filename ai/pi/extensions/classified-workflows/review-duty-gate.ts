import { resolve } from "node:path"
import { QUESTION_STATE_ENTRY } from "../shared/question-events.ts"
import { decodeQuestionState } from "../questions/state.ts"

export const REVIEW_DUTY_STATE_ENTRY = "classified-workflows.review-duty"
export const MAX_REVIEW_DUTY_COMPLETED_PASSES = 6

export interface ReviewDutyJob {
  readonly repository: string
  readonly pullRequest: number
  readonly kind: "own" | "assigned" | "auto"
}

export interface RuntimeReviewDutyContext {
  readonly sessionName: string | null
  readonly gateRequired: boolean
  readonly gateState: ReviewDutyState | null
}

interface ActiveReviewDutyJob extends ReviewDutyJob {
  readonly startedAt: number
  readonly continuation?: "fix-re-review"
}

interface ReportedReviewDutyJob extends ReviewDutyJob {
  readonly questionId: number
  readonly reportedAt: number
}

export type ReviewDutyState =
  | { readonly phase: "idle"; readonly lastReported?: ReportedReviewDutyJob }
  | ({ readonly phase: "active" } & ActiveReviewDutyJob)
  | ({
      readonly phase: "awaiting_report"
      readonly completedAt: number
    } & ActiveReviewDutyJob)

export interface ReviewDutyQuestion {
  readonly id: number
  readonly status: "pending" | "resolved"
  readonly question: string
  readonly options?: readonly { readonly label: string }[]
}

export type ReviewDutyTransition =
  | { readonly ok: true; readonly state: ReviewDutyState }
  | { readonly ok: false; readonly error: string }

export const emptyReviewDutyState: ReviewDutyState = { phase: "idle" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validRepository = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 120 &&
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(value) &&
  value.split("/").every(segment => !segment.startsWith("."))

const validPullRequest = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0

const validKind = (value: unknown): value is ReviewDutyJob["kind"] =>
  value === "own" || value === "assigned" || value === "auto"

const REVIEW_DUTY_SESSIONS = [
  "st0x-review-duty",
  "dataclique-review-duty",
  "personal-review-duty",
] as const

export const isReviewDutySession = (sessionName: string | undefined): boolean =>
  REVIEW_DUTY_SESSIONS.some(candidate => candidate === sessionName)

export const resolveReviewDutySessionName = (
  sessionName: string | undefined,
  cwd: string,
  home: string,
): (typeof REVIEW_DUTY_SESSIONS)[number] | undefined => {
  if (isReviewDutySession(sessionName))
    return sessionName as (typeof REVIEW_DUTY_SESSIONS)[number]
  const normalizedCwd = resolve(cwd)
  const managedRoots = [
    {
      root: resolve(home, "code", "st0x"),
      sessionName: "st0x-review-duty",
    },
    {
      root: resolve(home, "code", "dataclique"),
      sessionName: "dataclique-review-duty",
    },
    {
      root: resolve(home, "code", "0xgleb"),
      sessionName: "personal-review-duty",
    },
  ] as const
  return managedRoots.find(({ root }) => root === normalizedCwd)?.sessionName
}

export const runtimeReviewDutyContext = (
  sessionName: string | undefined,
  state: ReviewDutyState,
): RuntimeReviewDutyContext => ({
  sessionName: sessionName ?? null,
  gateRequired: isReviewDutySession(sessionName),
  gateState: isReviewDutySession(sessionName) ? state : null,
})

export const reviewDutyJobAllowed = (
  sessionName: string | undefined,
  job: ReviewDutyJob,
): boolean => {
  const repository = job.repository.toLowerCase()
  if (sessionName === "st0x-review-duty") return job.kind !== "auto"
  if (sessionName === "dataclique-review-duty") {
    if (!repository.startsWith("dataclique/")) return false
    return job.kind !== "auto" || repository === "dataclique/yielduck"
  }
  if (sessionName === "personal-review-duty") {
    if (!repository.startsWith("0xgleb/")) return false
    return job.kind !== "auto" || repository === "0xgleb/dotconfig"
  }
  return false
}

const validTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0

const sameJob = (left: ReviewDutyJob, right: ReviewDutyJob): boolean =>
  left.repository === right.repository &&
  left.pullRequest === right.pullRequest &&
  left.kind === right.kind

const jobLabel = (job: Pick<ReviewDutyJob, "pullRequest">): string =>
  `PR #${job.pullRequest}`

const awaitingReviewDutyRequirement = (job: ReviewDutyJob): string =>
  job.kind === "auto"
    ? "verified automatic review completion"
    : job.kind === "own"
      ? "retry-failed after a failed pass, continue after actionable findings, or complete-auto after a clean own-review pass"
      : "a persisted verdict question with an owner-authorized delivery channel"

export const beginReviewDuty = (
  state: ReviewDutyState,
  job: ReviewDutyJob,
  now: number,
): ReviewDutyTransition => {
  if (
    !validRepository(job.repository) ||
    !validPullRequest(job.pullRequest) ||
    !validKind(job.kind) ||
    !validTimestamp(now)
  ) {
    return { ok: false, error: "invalid review-duty job" }
  }
  if (state.phase === "awaiting_report") {
    return {
      ok: false,
      error: `${jobLabel(state)} still requires ${awaitingReviewDutyRequirement(state)}`,
    }
  }
  if (state.phase === "active") {
    return sameJob(state, job)
      ? { ok: true, state }
      : {
          ok: false,
          error: `${jobLabel(state)} is already the active review-duty job`,
        }
  }
  return { ok: true, state: { phase: "active", ...job, startedAt: now } }
}

export const startReviewWorkflow = (
  state: ReviewDutyState,
  now: number,
): ReviewDutyState =>
  state.phase === "active" && validTimestamp(now)
    ? { ...state, phase: "awaiting_report", completedAt: now }
    : state

const toolResultText = (message: Record<string, unknown>): string =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .filter(
            (part): part is Record<string, unknown> =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string",
          )
          .map(part => String(part.text))
          .join("\n")
      : ""

export const preExecutionReviewWorkflowBlockObserved = (
  entries: readonly unknown[],
  state: ReviewDutyState,
): boolean => {
  if (state.phase !== "awaiting_report") return false
  let awaitingStateIndex = -1
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || entry.type !== "custom") continue
    if (entry.customType !== REVIEW_DUTY_STATE_ENTRY || !isRecord(entry.data))
      continue
    if (
      entry.data.phase === "awaiting_report" &&
      entry.data.repository === state.repository &&
      entry.data.pullRequest === state.pullRequest &&
      entry.data.kind === state.kind &&
      entry.data.completedAt === state.completedAt
    ) {
      awaitingStateIndex = index
    }
  }
  if (awaitingStateIndex < 0) return false

  const results = entries.slice(awaitingStateIndex + 1).flatMap(entry => {
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      return []
    const message = entry.message
    return message.role === "toolResult" && message.toolName === "workflow"
      ? [message]
      : []
  })
  if (results.some(message => message.isError === false)) return false
  return results.some(
    message =>
      message.isError === true &&
      /(?:auto-classifier|deterministic policy) verdict|blocked by classified workflow policy/i.test(
        toolResultText(message),
      ),
  )
}

export const retryBlockedReviewDuty = (
  state: ReviewDutyState,
  workflowObserved: boolean,
  preExecutionBlockObserved: boolean,
): ReviewDutyTransition => {
  if (state.phase !== "awaiting_report") {
    return {
      ok: false,
      error: "no pre-execution review-duty workflow block awaits recovery",
    }
  }
  if (!preExecutionBlockObserved) {
    return {
      ok: false,
      error:
        "no matching pre-execution workflow classifier block is persisted after the awaiting state",
    }
  }
  if (workflowObserved) {
    return {
      ok: false,
      error: `review-duty workflow execution evidence exists; ${awaitingReviewDutyRequirement(state)} is required`,
    }
  }
  const { completedAt: _completedAt, ...active } = state
  return { ok: true, state: { ...active, phase: "active" } }
}

export const recoverCompletedReviewDuty = (
  state: ReviewDutyState,
  completedWorkflowStartedAt: number,
  usableCompletedWorkflowObserved: boolean,
  workflowRunning: boolean,
): ReviewDutyTransition => {
  if (state.phase !== "active") {
    return {
      ok: false,
      error: "no active review-duty job can recover completed evidence",
    }
  }
  if (workflowRunning) {
    return { ok: false, error: "the review-duty workflow is still running" }
  }
  if (!usableCompletedWorkflowObserved) {
    return {
      ok: false,
      error: "no usable completed review evidence awaits verdict recovery",
    }
  }
  if (
    !validTimestamp(completedWorkflowStartedAt) ||
    completedWorkflowStartedAt < state.startedAt
  ) {
    return {
      ok: false,
      error: "completed review evidence predates the active review-duty job",
    }
  }
  return {
    ok: true,
    state: {
      ...state,
      phase: "awaiting_report",
      completedAt: completedWorkflowStartedAt,
    },
  }
}

export const continueReviewDuty = (
  state: ReviewDutyState,
  completedWorkflowObserved: boolean,
  workflowRunning: boolean,
  completedPasses: number,
): ReviewDutyTransition => {
  if (state.phase !== "awaiting_report") {
    return {
      ok: false,
      error: "no completed review-duty pass awaits continuation",
    }
  }
  if (workflowRunning) {
    return { ok: false, error: "the review-duty workflow is still running" }
  }
  if (!completedWorkflowObserved) {
    return {
      ok: false,
      error: "the latest review-duty workflow is not proven completed",
    }
  }
  if (
    !Number.isSafeInteger(completedPasses) ||
    completedPasses < 1 ||
    completedPasses >= MAX_REVIEW_DUTY_COMPLETED_PASSES
  ) {
    return {
      ok: false,
      error: `review-duty reached its bounded ${MAX_REVIEW_DUTY_COMPLETED_PASSES}-pass limit; final reporting or an explicit user decision is required`,
    }
  }
  const { completedAt: _completedAt, ...active } = state
  return {
    ok: true,
    state: { ...active, phase: "active", continuation: "fix-re-review" },
  }
}

export const completeAutoReviewDuty = (
  state: ReviewDutyState,
  completedWorkflowObserved: boolean,
  workflowRunning: boolean,
  allowedCompletionLane: boolean,
): ReviewDutyTransition => {
  if (
    state.phase !== "awaiting_report" ||
    (state.kind !== "auto" && state.kind !== "own")
  ) {
    return {
      ok: false,
      error: "no automatic or own review-duty job awaits completion",
    }
  }
  if (!allowedCompletionLane) {
    return {
      ok: false,
      error:
        "automatic or own completion is not allowed for this reviewer repository",
    }
  }
  if (workflowRunning) {
    return { ok: false, error: "the review-duty workflow is still running" }
  }
  if (!completedWorkflowObserved) {
    return {
      ok: false,
      error: "the latest automatic review workflow is not proven completed",
    }
  }
  return { ok: true, state: emptyReviewDutyState }
}

export const releaseUnusableReviewDuty = (
  state: ReviewDutyState,
  usableCompletedWorkflowObserved: boolean,
  workflowRunning: boolean,
): ReviewDutyTransition => {
  if (state.phase === "idle") {
    return { ok: false, error: "no active review-duty job can be released" }
  }
  if (workflowRunning) {
    return { ok: false, error: "the review-duty workflow is still running" }
  }
  if (usableCompletedWorkflowObserved) {
    return {
      ok: false,
      error: `usable completed review evidence exists; ${awaitingReviewDutyRequirement(state)} remains required`,
    }
  }
  return { ok: true, state: emptyReviewDutyState }
}

export const retryFailedReviewDuty = (
  state: ReviewDutyState,
  latestWorkflowFailed: boolean,
  workflowRunning: boolean,
  latestWorkflowCancelledByManagedReload = false,
  legacyManagedReloadContinuationMarkerLost = false,
): ReviewDutyTransition => {
  if (state.phase !== "awaiting_report") {
    return {
      ok: false,
      error: "no failed review-duty workflow awaits recovery",
    }
  }
  if (workflowRunning) {
    return {
      ok: false,
      error: "the review-duty workflow is still running",
    }
  }
  const recoverableManagedReloadCancellation =
    latestWorkflowCancelledByManagedReload &&
    state.kind === "auto" &&
    (state.continuation === "fix-re-review" ||
      legacyManagedReloadContinuationMarkerLost)
  if (!latestWorkflowFailed && !recoverableManagedReloadCancellation) {
    return {
      ok: false,
      error:
        state.kind === "auto"
          ? "the latest automatic workflow is not a proven terminal failure or managed-reload-cancelled fix continuation"
          : `the latest workflow is not a proven terminal failure; ${awaitingReviewDutyRequirement(state)} is required`,
    }
  }
  const { completedAt: _completedAt, ...active } = state
  return {
    ok: true,
    state: {
      ...active,
      phase: "active",
      ...(legacyManagedReloadContinuationMarkerLost
        ? { continuation: "fix-re-review" as const }
        : {}),
    },
  }
}

const normalizedOptions = (question: ReviewDutyQuestion): readonly string[] =>
  (question.options ?? []).map(({ label }) => label.trim().toLowerCase())

export const reportReviewDuty = (
  state: ReviewDutyState,
  question: ReviewDutyQuestion,
  deliveryAuthorized: boolean,
  now: number,
): ReviewDutyTransition => {
  if (state.phase !== "awaiting_report") {
    return { ok: false, error: "no completed review-duty job awaits a report" }
  }
  if (state.kind === "auto") {
    return {
      ok: false,
      error:
        "automatic review-duty jobs complete through complete-auto, not a user verdict",
    }
  }
  if (state.kind === "own") {
    return {
      ok: false,
      error:
        "own review-duty jobs complete without a user verdict through continue, retry-failed, or complete-auto",
    }
  }
  if (!deliveryAuthorized) {
    return {
      ok: false,
      error: `question ${question.id} is not linked to an owner-authorized delivery channel`,
    }
  }
  if (!Number.isSafeInteger(question.id) || question.id <= 0) {
    return { ok: false, error: "invalid verdict question id" }
  }
  const options = normalizedOptions(question)
  if (
    options.length !== 3 ||
    options[0] !== "approve" ||
    options[1] !== "request changes" ||
    options[2] !== "inspect first"
  ) {
    return {
      ok: false,
      error:
        "review-duty reporting requires three verdict options in order: Approve, Request changes, Inspect first",
    }
  }
  if (!question.question.includes(`#${state.pullRequest}`)) {
    return {
      ok: false,
      error: `verdict question must identify ${jobLabel(state)}`,
    }
  }
  if (!/(?:assessment|finding|clean|blocked)/i.test(question.question)) {
    return {
      ok: false,
      error:
        "verdict question must include a concise assessment and verified finding status",
    }
  }
  if (!validTimestamp(now)) {
    return { ok: false, error: "invalid report timestamp" }
  }
  return {
    ok: true,
    state: {
      phase: "idle",
      lastReported: {
        repository: state.repository,
        pullRequest: state.pullRequest,
        kind: state.kind,
        questionId: question.id,
        reportedAt: now,
      },
    },
  }
}

export const clearedHistoricalReviewQuestion = (
  entries: readonly unknown[],
  questionId: number,
): ReviewDutyQuestion | undefined => {
  let latestState = undefined as ReturnType<typeof decodeQuestionState>
  let lastResolved: ReviewDutyQuestion | undefined
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== QUESTION_STATE_ENTRY
    )
      continue
    const decoded = decodeQuestionState(entry.data)
    if (!decoded) continue
    latestState = decoded
    const question = decoded.questions.find(({ id }) => id === questionId)
    if (question?.status === "resolved") {
      lastResolved = {
        id: question.id,
        status: question.status,
        question: question.question,
        ...(question.options ? { options: question.options } : {}),
      }
    }
  }
  if (
    !lastResolved ||
    latestState?.questions.some(({ id }) => id === questionId)
  )
    return undefined
  return lastResolved
}

export const isPullRequestReviewWorkflow = (input: unknown): boolean => {
  if (!isRecord(input)) return false
  const label = typeof input.label === "string" ? input.label : ""
  return (
    /\b(?:review|re-review|cross-review)\b/i.test(label) &&
    /(?:\bpull request\b|\bPR\s*#?\s*\d+\b|#\d+\b|github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)/i.test(
      label,
    )
  )
}

export const reviewWorkflowBlockReason = (
  sessionName: string | undefined,
  state: ReviewDutyState,
  workflowInput: unknown,
): string | undefined => {
  if (
    !isReviewDutySession(sessionName) ||
    !isPullRequestReviewWorkflow(workflowInput)
  )
    return undefined
  if (state.phase === "idle") {
    return "Dedicated review workflows require review_duty begin with repository, pull request, and own/assigned kind"
  }
  if (state.phase === "awaiting_report") {
    return `${jobLabel(state)} cannot advance until ${awaitingReviewDutyRequirement(state)}`
  }
  return undefined
}

const decodeJob = (
  value: Record<string, unknown>,
): ReviewDutyJob | undefined =>
  validRepository(value.repository) &&
  validPullRequest(value.pullRequest) &&
  validKind(value.kind)
    ? {
        repository: value.repository,
        pullRequest: value.pullRequest,
        kind: value.kind,
      }
    : undefined

const decodeReviewDutyState = (value: unknown): ReviewDutyState | undefined => {
  if (!isRecord(value)) return undefined
  if (value.phase === "idle") {
    if (value.lastReported === undefined) return emptyReviewDutyState
    if (!isRecord(value.lastReported)) return undefined
    const job = decodeJob(value.lastReported)
    return job &&
      validPullRequest(value.lastReported.questionId) &&
      validTimestamp(value.lastReported.reportedAt)
      ? {
          phase: "idle",
          lastReported: {
            ...job,
            questionId: value.lastReported.questionId,
            reportedAt: value.lastReported.reportedAt,
          },
        }
      : undefined
  }
  const job = decodeJob(value)
  if (!job || !validTimestamp(value.startedAt)) return undefined
  if (
    value.continuation !== undefined &&
    value.continuation !== "fix-re-review"
  )
    return undefined
  const continuation: Pick<ActiveReviewDutyJob, "continuation"> =
    value.continuation === "fix-re-review"
      ? { continuation: value.continuation }
      : {}
  if (value.phase === "active") {
    return {
      phase: "active",
      ...job,
      startedAt: value.startedAt,
      ...continuation,
    }
  }
  if (value.phase === "awaiting_report" && validTimestamp(value.completedAt)) {
    return {
      phase: "awaiting_report",
      ...job,
      startedAt: value.startedAt,
      completedAt: value.completedAt,
      ...continuation,
    }
  }
  return undefined
}

const messageText = (
  message: Readonly<Record<string, unknown>>,
): string | undefined => {
  if (typeof message.content === "string") return message.content.trim()
  if (!Array.isArray(message.content)) return undefined
  const text = message.content
    .filter(
      (part): part is Readonly<Record<string, unknown>> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map(part => String(part.text))
    .join("\n")
    .trim()
  return text || undefined
}

const IN_CONVERSATION_VERDICT_AUTHORIZATION =
  /^\s*(?:(?:please|actually|just|okay|ok|then)[,\s]+)*(?:(?:can|could|would)\s+you\s+)?(?:ask|show|present)\b[^\r\n.!?]{0,120}\b(?:here|in (?:this|the) (?:chat|conversation|pane))\b/i
const TELEGRAM_VERDICT_AUTHORIZATION =
  /^\s*(?:(?:please|actually|just|okay|ok|then)[,\s]+)*(?:(?:can|could|would)\s+you\s+)?(?:ask|show|present|send|relay)\b[^\r\n.!?]{0,120}\btelegram\b/i

export const inConversationReviewQuestionAuthorized = (
  entries: readonly unknown[],
  state: ReviewDutyState,
  question: ReviewDutyQuestion,
): boolean => {
  if (state.phase !== "awaiting_report" || state.kind !== "assigned")
    return false
  const options = normalizedOptions(question)
  if (
    !Number.isSafeInteger(question.id) ||
    question.id <= 0 ||
    options.length !== 3 ||
    options[0] !== "approve" ||
    options[1] !== "request changes" ||
    options[2] !== "inspect first" ||
    !question.question.includes(`#${state.pullRequest}`) ||
    !/(?:assessment|finding|clean|blocked)/i.test(question.question)
  )
    return false

  const gateIndex = entries.findLastIndex(entry => {
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== REVIEW_DUTY_STATE_ENTRY
    )
      return false
    const candidate = decodeReviewDutyState(entry.data)
    return (
      candidate?.phase === "awaiting_report" &&
      sameJob(candidate, state) &&
      candidate.startedAt === state.startedAt &&
      candidate.completedAt === state.completedAt
    )
  })
  if (gateIndex < 0) return false

  let latestOwnerDelivery: "conversation" | "telegram" | undefined
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message) ||
      entry.message.role !== "user"
    )
      continue
    const text = messageText(entry.message)
    if (!text) continue
    if (IN_CONVERSATION_VERDICT_AUTHORIZATION.test(text))
      latestOwnerDelivery = "conversation"
    else if (TELEGRAM_VERDICT_AUTHORIZATION.test(text))
      latestOwnerDelivery = "telegram"
  }

  const exactQuestionPersisted = entries.slice(gateIndex + 1).some(entry => {
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== QUESTION_STATE_ENTRY
    )
      return false
    const persisted = decodeQuestionState(entry.data)?.questions.find(
      ({ id }) => id === question.id,
    )
    return (
      persisted?.question === question.question &&
      normalizedOptions(persisted).join("\n") === options.join("\n")
    )
  })
  return latestOwnerDelivery === "conversation" && exactQuestionPersisted
}

const continuedToolResultAfter = (
  entries: readonly unknown[],
  stateIndex: number,
  state: ReviewDutyState,
): boolean =>
  state.phase === "active" &&
  entries.slice(stateIndex + 1).some(entry => {
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      return false
    const message = entry.message
    if (
      message.role !== "toolResult" ||
      message.toolName !== "review_duty" ||
      !isRecord(message.details) ||
      message.details.outcome !== "continued" ||
      !isRecord(message.details.state)
    )
      return false
    const resultState = decodeReviewDutyState(message.details.state)
    return resultState?.phase === "active" && sameJob(resultState, state)
  })

const continuedToolResultBefore = (
  entries: readonly unknown[],
  stateIndex: number,
  state: ReviewDutyJob,
): boolean => {
  for (let index = stateIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      !isRecord(entry.message)
    )
      continue
    const message = entry.message
    if (
      message.role !== "toolResult" ||
      message.toolName !== "review_duty" ||
      !isRecord(message.details)
    )
      continue
    if (
      message.details.outcome === "error" ||
      message.details.outcome === "status"
    )
      continue
    const continued = message.details.outcome === "continued"
    const recoveredLegacyAutoContinuation =
      state.kind === "auto" &&
      message.details.outcome === "retry-failed" &&
      /^Recovered managed-reload-cancelled workflow\b/.test(
        toolResultText(message),
      )
    if (
      (!continued && !recoveredLegacyAutoContinuation) ||
      !isRecord(message.details.state)
    )
      return false
    const resultState = decodeReviewDutyState(message.details.state)
    return resultState?.phase === "active" && sameJob(resultState, state)
  }
  return false
}

export const restoreReviewDutyState = (
  entries: readonly unknown[],
): ReviewDutyState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === REVIEW_DUTY_STATE_ENTRY
    ) {
      const state = decodeReviewDutyState(entry.data) ?? emptyReviewDutyState
      const migratedContinuation =
        state.phase !== "idle" &&
        state.continuation === undefined &&
        (continuedToolResultAfter(entries, index, state) ||
          continuedToolResultBefore(entries, index, state))
      return migratedContinuation
        ? { ...state, continuation: "fix-re-review" }
        : state
    }
  }
  return emptyReviewDutyState
}
