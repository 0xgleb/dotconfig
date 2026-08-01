export const REVIEW_DUTY_STATE_ENTRY = "classified-workflows.review-duty";

export interface ReviewDutyJob {
  readonly repository: string;
  readonly pullRequest: number;
  readonly kind: "own" | "assigned";
}

interface ActiveReviewDutyJob extends ReviewDutyJob {
  readonly startedAt: number;
}

interface ReportedReviewDutyJob extends ReviewDutyJob {
  readonly questionId: number;
  readonly reportedAt: number;
}

export type ReviewDutyState =
  | { readonly phase: "idle"; readonly lastReported?: ReportedReviewDutyJob }
  | ({ readonly phase: "active" } & ActiveReviewDutyJob)
  | ({ readonly phase: "awaiting_report"; readonly completedAt: number } &
      ActiveReviewDutyJob);

export interface ReviewDutyQuestion {
  readonly id: number;
  readonly status: "pending" | "resolved";
  readonly question: string;
  readonly options?: readonly { readonly label: string }[];
}

export type ReviewDutyTransition =
  | { readonly ok: true; readonly state: ReviewDutyState }
  | { readonly ok: false; readonly error: string };

export const emptyReviewDutyState: ReviewDutyState = { phase: "idle" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validRepository = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_.-]{1,120}$/.test(value) &&
  !value.startsWith(".");

const validPullRequest = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const validKind = (value: unknown): value is ReviewDutyJob["kind"] =>
  value === "own" || value === "assigned";

const validTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const sameJob = (left: ReviewDutyJob, right: ReviewDutyJob): boolean =>
  left.repository === right.repository &&
  left.pullRequest === right.pullRequest &&
  left.kind === right.kind;

const jobLabel = (job: Pick<ReviewDutyJob, "pullRequest">): string =>
  `PR #${job.pullRequest}`;

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
    return { ok: false, error: "invalid review-duty job" };
  }
  if (state.phase === "awaiting_report") {
    return {
      ok: false,
      error: `${jobLabel(state)} still requires a persisted and relayed verdict question`,
    };
  }
  if (state.phase === "active") {
    return sameJob(state, job)
      ? { ok: true, state }
      : {
          ok: false,
          error: `${jobLabel(state)} is already the active review-duty job`,
        };
  }
  return { ok: true, state: { phase: "active", ...job, startedAt: now } };
};

export const startReviewWorkflow = (
  state: ReviewDutyState,
  now: number,
): ReviewDutyState =>
  state.phase === "active" && validTimestamp(now)
    ? { ...state, phase: "awaiting_report", completedAt: now }
    : state;

const normalizedOptions = (
  question: ReviewDutyQuestion,
): readonly string[] =>
  (question.options ?? []).map(({ label }) => label.trim().toLowerCase());

export const reportReviewDuty = (
  state: ReviewDutyState,
  question: ReviewDutyQuestion,
  relayed: boolean,
  now: number,
): ReviewDutyTransition => {
  if (state.phase !== "awaiting_report") {
    return { ok: false, error: "no completed review-duty job awaits a report" };
  }
  if (!relayed) {
    return {
      ok: false,
      error: `question ${question.id} is not linked to Piece of Pi Telegram relay`,
    };
  }
  if (!Number.isSafeInteger(question.id) || question.id <= 0) {
    return { ok: false, error: "invalid verdict question id" };
  }
  const options = normalizedOptions(question);
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
    };
  }
  if (!question.question.includes(`#${state.pullRequest}`)) {
    return {
      ok: false,
      error: `verdict question must identify ${jobLabel(state)}`,
    };
  }
  if (!/(?:assessment|finding|clean|blocked)/i.test(question.question)) {
    return {
      ok: false,
      error:
        "verdict question must include a concise assessment and verified finding status",
    };
  }
  if (!validTimestamp(now)) {
    return { ok: false, error: "invalid report timestamp" };
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
  };
};

export const reviewWorkflowBlockReason = (
  sessionName: string | undefined,
  state: ReviewDutyState,
): string | undefined => {
  if (sessionName !== "st0x-review-duty") return undefined;
  if (state.phase === "idle") {
    return "Dedicated review workflows require review_duty begin with repository, pull request, and own/assigned kind";
  }
  if (state.phase === "awaiting_report") {
    return `${jobLabel(state)} cannot advance until its typed verdict question is persisted and linked to Piece of Pi Telegram relay`;
  }
  return undefined;
};

const decodeJob = (value: Record<string, unknown>): ReviewDutyJob | undefined =>
  validRepository(value.repository) &&
  validPullRequest(value.pullRequest) &&
  validKind(value.kind)
    ? {
        repository: value.repository,
        pullRequest: value.pullRequest,
        kind: value.kind,
      }
    : undefined;

const decodeReviewDutyState = (value: unknown): ReviewDutyState | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.phase === "idle") {
    if (value.lastReported === undefined) return emptyReviewDutyState;
    if (!isRecord(value.lastReported)) return undefined;
    const job = decodeJob(value.lastReported);
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
      : undefined;
  }
  const job = decodeJob(value);
  if (!job || !validTimestamp(value.startedAt)) return undefined;
  if (value.phase === "active") {
    return { phase: "active", ...job, startedAt: value.startedAt };
  }
  if (
    value.phase === "awaiting_report" &&
    validTimestamp(value.completedAt)
  ) {
    return {
      phase: "awaiting_report",
      ...job,
      startedAt: value.startedAt,
      completedAt: value.completedAt,
    };
  }
  return undefined;
};

export const restoreReviewDutyState = (
  entries: readonly unknown[],
): ReviewDutyState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === REVIEW_DUTY_STATE_ENTRY
    ) {
      return decodeReviewDutyState(entry.data) ?? emptyReviewDutyState;
    }
  }
  return emptyReviewDutyState;
};
