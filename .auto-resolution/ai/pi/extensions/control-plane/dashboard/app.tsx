import {
  createMemo,
  createResource,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { render } from "solid-js/web"
import { Effect, Either } from "effect"
import { decodeStoredJob, type Job } from "../job-runtime.ts"
import { jobSchedulePresentation, relativeTime } from "../job-presentation.ts"
import {
  allowancePoolLabel,
  isAllowancePool,
  isAllowanceSource,
  selectedAllowanceCheckpoints,
  type ProviderAllowanceCheckpoint,
} from "../allowance-pool.ts"
import {
  allowanceRunway,
  isAllowanceRemainingPercent,
  MAX_ALLOWANCE_CHECKPOINT_AGE_MS,
  usagePolicy,
} from "../usage-policy.ts"
import {
  allowanceChartDomain,
  allowanceChartSegments,
  allowanceChartX,
  reconstructChatGptSharedHistory,
  type AllowanceChartPoint,
  type AllowanceHistoryEvent,
} from "./allowance-chart.ts"

type JobState =
  | "scheduled"
  | "ready"
  | "leased"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled"

interface Health {
  readonly status: "ok"
  readonly protocolVersion: number
  readonly schemaVersion: number
}

interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
}

interface AgentPresence {
  readonly id: string
  readonly presence: "runtime" | "managed-pane" | "bridge-endpoint"
  readonly label: string
  readonly cwd: string
  readonly model?: string
  readonly usage: TokenUsage
  readonly activities: readonly {
    readonly todoId: number
    readonly status: "in_progress" | "in_review" | "pending"
    readonly text: string
  }[]
  readonly roles: readonly {
    readonly project: string
    readonly role: string
    readonly mode: "task" | "operational"
  }[]
  readonly heartbeatAt: number
  readonly expiresAt: number
}

interface AgentUsageSample {
  readonly agentId: string
  readonly label: string
  readonly cwd: string
  readonly model?: string
  readonly capturedAt: number
  readonly usage: TokenUsage
}

type AllowanceCheckpoint = ProviderAllowanceCheckpoint

interface DashboardThrottleActivity {
  readonly counts: { readonly deferred: number }
  readonly pausedRoles: readonly {
    readonly role: string
    readonly retryAt: number
  }[]
}

interface UsageHistory {
  readonly samples: readonly AgentUsageSample[]
  readonly checkpoints: readonly AllowanceCheckpoint[]
  readonly control: {
    readonly provider: "openai"
    readonly pool: "chatgpt-shared-weekly" | "codex-app-server-weekly"
    readonly source: "manual" | "codex-app-server" | "unavailable"
    readonly activity?: DashboardThrottleActivity
  }
  readonly sampling: {
    readonly status: "unavailable" | "sampling" | "ok" | "error"
    readonly lastAttemptAt?: number
    readonly lastCapturedAt?: number
    readonly error?: "registry" | "store"
  }
}

const stateLabel: Readonly<Record<JobState, string>> = {
  scheduled: "Scheduled",
  ready: "Ready",
  leased: "Running",
  retry_wait: "Retry wait",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
}

const formatTokens = (value: number): string =>
  new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)

const projectLabel = (
  sample: Pick<AgentUsageSample, "cwd" | "label">,
): string => {
  if (sample.cwd.includes("/code/dataclique/yielduck")) return "Yielduck"
  if (sample.cwd.includes("/code/st0x/")) return "st0x"
  if (sample.cwd.endsWith("/.config")) return "dotconfig"
  return sample.label
}

type ApiResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const decodeHealth = (value: unknown): Health | undefined => {
  if (
    !isRecord(value) ||
    value.status !== "ok" ||
    typeof value.protocolVersion !== "number" ||
    !Number.isSafeInteger(value.protocolVersion) ||
    typeof value.schemaVersion !== "number" ||
    !Number.isSafeInteger(value.schemaVersion)
  )
    return undefined
  return {
    status: "ok",
    protocolVersion: Number(value.protocolVersion),
    schemaVersion: Number(value.schemaVersion),
  }
}

const decodeTokenUsage = (value: unknown): TokenUsage | undefined => {
  if (
    !isRecord(value) ||
    !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
      key =>
        typeof value[key] === "number" &&
        Number.isSafeInteger(value[key]) &&
        Number(value[key]) >= 0,
    )
  )
    return undefined
  return value as unknown as TokenUsage
}

const decodeThrottleActivity = (
  value: unknown,
): DashboardThrottleActivity | undefined => {
  if (
    !isRecord(value) ||
    !isRecord(value.counts) ||
    !Number.isSafeInteger(value.counts.deferred) ||
    Number(value.counts.deferred) < 0 ||
    !Array.isArray(value.pausedRoles) ||
    !value.pausedRoles.every(
      paused =>
        isRecord(paused) &&
        typeof paused.role === "string" &&
        paused.role.length > 0 &&
        Number.isSafeInteger(paused.retryAt) &&
        Number(paused.retryAt) >= 0,
    )
  )
    return undefined
  return {
    counts: { deferred: Number(value.counts.deferred) },
    pausedRoles: value.pausedRoles.map(paused => ({
      role: String(paused.role),
      retryAt: Number(paused.retryAt),
    })),
  }
}

const decodeUsage = (value: unknown): UsageHistory | undefined => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.samples) ||
    !Array.isArray(value.checkpoints) ||
    !isRecord(value.control) ||
    value.control.provider !== "openai" ||
    (value.control.pool !== "chatgpt-shared-weekly" &&
      value.control.pool !== "codex-app-server-weekly") ||
    (value.control.source !== "manual" &&
      value.control.source !== "codex-app-server" &&
      value.control.source !== "unavailable") ||
    !isRecord(value.sampling) ||
    !["unavailable", "sampling", "ok", "error"].includes(
      String(value.sampling.status),
    ) ||
    (value.sampling.lastAttemptAt !== undefined &&
      (!Number.isSafeInteger(value.sampling.lastAttemptAt) ||
        Number(value.sampling.lastAttemptAt) < 0)) ||
    (value.sampling.lastCapturedAt !== undefined &&
      (!Number.isSafeInteger(value.sampling.lastCapturedAt) ||
        Number(value.sampling.lastCapturedAt) < 0)) ||
    (value.sampling.error !== undefined &&
      value.sampling.error !== "registry" &&
      value.sampling.error !== "store")
  )
    return undefined
  const activity = decodeThrottleActivity(value.control.activity)
  if (value.control.activity !== undefined && !activity) return undefined
  const samples: AgentUsageSample[] = []
  for (const candidate of value.samples) {
    if (
      !isRecord(candidate) ||
      typeof candidate.agentId !== "string" ||
      typeof candidate.label !== "string" ||
      typeof candidate.cwd !== "string" ||
      (candidate.model !== undefined && typeof candidate.model !== "string") ||
      !Number.isSafeInteger(candidate.capturedAt) ||
      Number(candidate.capturedAt) < 0
    )
      return undefined
    const usage = decodeTokenUsage(candidate.usage)
    if (!usage) return undefined
    samples.push({
      agentId: candidate.agentId,
      label: candidate.label,
      cwd: candidate.cwd,
      ...(candidate.model ? { model: candidate.model } : {}),
      capturedAt: Number(candidate.capturedAt),
      usage,
    })
  }
  const checkpoints: AllowanceCheckpoint[] = []
  for (const candidate of value.checkpoints) {
    if (
      !isRecord(candidate) ||
      !isAllowancePool(candidate.provider, candidate.pool) ||
      !isAllowanceSource(candidate.source) ||
      typeof candidate.capturedAt !== "number" ||
      !Number.isSafeInteger(candidate.capturedAt) ||
      candidate.capturedAt < 0 ||
      !isAllowanceRemainingPercent(candidate.remainingPercent) ||
      typeof candidate.resetAt !== "number" ||
      !Number.isSafeInteger(candidate.resetAt) ||
      candidate.resetAt <= candidate.capturedAt
    )
      return undefined
    checkpoints.push({
      provider: candidate.provider,
      pool: candidate.pool,
      source: candidate.source,
      capturedAt: candidate.capturedAt,
      remainingPercent: candidate.remainingPercent,
      resetAt: candidate.resetAt,
    })
  }
  return {
    samples,
    checkpoints,
    control: {
      provider: "openai",
      pool: value.control.pool,
      source: value.control.source,
      ...(activity ? { activity } : {}),
    },
    sampling: value.sampling as unknown as UsageHistory["sampling"],
  }
}

const decodeAgents = (value: unknown): readonly AgentPresence[] | undefined => {
  if (!isRecord(value) || !Array.isArray(value.agents)) return undefined
  const agents: AgentPresence[] = []
  for (const candidate of value.agents) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      (candidate.presence !== "runtime" &&
        candidate.presence !== "managed-pane" &&
        candidate.presence !== "bridge-endpoint") ||
      typeof candidate.label !== "string" ||
      typeof candidate.cwd !== "string" ||
      (candidate.model !== undefined && typeof candidate.model !== "string") ||
      !isRecord(candidate.usage) ||
      !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
        key =>
          typeof candidate.usage[key] === "number" &&
          Number.isSafeInteger(candidate.usage[key]) &&
          Number(candidate.usage[key]) >= 0,
      ) ||
      !Array.isArray(candidate.activities) ||
      !candidate.activities.every(
        activity =>
          isRecord(activity) &&
          typeof activity.todoId === "number" &&
          Number.isSafeInteger(activity.todoId) &&
          activity.todoId >= 1 &&
          (activity.status === "in_progress" ||
            activity.status === "in_review" ||
            activity.status === "pending") &&
          typeof activity.text === "string",
      ) ||
      !Array.isArray(candidate.roles) ||
      !candidate.roles.every(
        role =>
          isRecord(role) &&
          typeof role.project === "string" &&
          typeof role.role === "string" &&
          (role.mode === "task" || role.mode === "operational"),
      ) ||
      typeof candidate.heartbeatAt !== "number" ||
      !Number.isSafeInteger(candidate.heartbeatAt) ||
      typeof candidate.expiresAt !== "number" ||
      !Number.isSafeInteger(candidate.expiresAt)
    )
      return undefined
    agents.push(candidate as unknown as AgentPresence)
  }
  return agents
}

const decodeJobs = (value: unknown): readonly Job[] | undefined => {
  if (!isRecord(value) || !Array.isArray(value.jobs)) return undefined
  const decoded = value.jobs.map(candidate =>
    Effect.runSync(Effect.either(decodeStoredJob(candidate))),
  )
  if (decoded.some(Either.isLeft)) return undefined
  return decoded.flatMap(result =>
    Either.isRight(result) ? [result.right] : [],
  )
}

const fetchJson = async (path: string): Promise<ApiResult> =>
  fetch(path, { headers: { accept: "application/json" } })
    .then(async response => {
      if (!response.ok) return { ok: false as const }
      const value: unknown = await response.json()
      return { ok: true as const, value }
    })
    .catch(() => ({ ok: false as const }))

interface DashboardSnapshot {
  readonly health: Health
  readonly agents: readonly AgentPresence[]
  readonly jobs: readonly Job[]
  readonly usage: UsageHistory
  readonly refreshedAt: number
}

const fetchSnapshot = async (): Promise<DashboardSnapshot | undefined> => {
  const [healthResult, agentsResult, jobsResult, usageResult] =
    await Promise.all([
      fetchJson("/v1/health"),
      fetchJson("/v1/agents"),
      fetchJson("/v1/jobs"),
      fetchJson("/v1/usage"),
    ])
  const health = healthResult.ok ? decodeHealth(healthResult.value) : undefined
  const agents = agentsResult.ok ? decodeAgents(agentsResult.value) : undefined
  const jobs = jobsResult.ok ? decodeJobs(jobsResult.value) : undefined
  const usage = usageResult.ok ? decodeUsage(usageResult.value) : undefined
  return health && agents && jobs && usage
    ? { health, agents, jobs, usage, refreshedAt: Date.now() }
    : undefined
}

const App = () => {
  const [snapshot, { refetch }] = createResource(fetchSnapshot)

  onMount(() => {
    const timer = setInterval(() => void refetch(), 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const agents = createMemo(() => snapshot()?.agents ?? [])
  const onlineAgents = createMemo(() =>
    agents().filter(
      ({ presence, roles, activities }) =>
        presence !== "bridge-endpoint" &&
        (roles.length > 0 ||
          activities.some(({ status }) => status !== "pending")),
    ),
  )
  const unassignedRuntimes = createMemo(() =>
    agents().filter(
      ({ presence, roles, activities }) =>
        presence !== "bridge-endpoint" &&
        roles.length === 0 &&
        activities.every(({ status }) => status === "pending"),
    ),
  )
  const bridgeEndpoints = createMemo(() =>
    agents().filter(({ presence }) => presence === "bridge-endpoint"),
  )
  const jobs = createMemo(() => snapshot()?.jobs ?? [])
  const health = createMemo(() => snapshot()?.health)
  const usageHistory = createMemo(() => snapshot()?.usage)
  const latestUsage = createMemo(() => {
    const latest = new Map<string, AgentUsageSample>()
    for (const sample of usageHistory()?.samples ?? [])
      latest.set(sample.agentId, sample)
    return [...latest.values()]
  })
  const recordedTokens = createMemo(() =>
    latestUsage().reduce(
      (total, sample) => total + sample.usage.totalTokens,
      0,
    ),
  )
  const projectUsage = createMemo(() => {
    const totals = new Map<string, number>()
    for (const sample of latestUsage()) {
      const project = projectLabel(sample)
      totals.set(project, (totals.get(project) ?? 0) + sample.usage.totalTokens)
    }
    return [...totals.entries()]
      .map(([project, tokens]) => ({ project, tokens }))
      .sort((left, right) => right.tokens - left.tokens)
  })
  const usageTrend = createMemo(() => {
    const samples = usageHistory()?.samples ?? []
    const running = new Map<string, number>()
    const points: { capturedAt: number; tokens: number }[] = []
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]
      if (!sample) continue
      running.set(sample.agentId, sample.usage.totalTokens)
      if (samples[index + 1]?.capturedAt === sample.capturedAt) continue
      points.push({
        capturedAt: sample.capturedAt,
        tokens: [...running.values()].reduce(
          (total, tokens) => total + tokens,
          0,
        ),
      })
    }
    return points
  })
  const trendPolyline = createMemo(() => {
    const trend = usageTrend()
    if (trend.length === 0) return ""
    if (trend.length === 1) return "0,28 100,28"
    const maximum = Math.max(...trend.map(({ tokens }) => tokens), 1)
    return trend
      .map(
        ({ tokens }, index) =>
          `${(index / (trend.length - 1)) * 100},${28 - (tokens / maximum) * 26}`,
      )
      .join(" ")
  })
  const activePool = createMemo(
    () => usageHistory()?.control.pool ?? "chatgpt-shared-weekly",
  )
  const activeCheckpoints = createMemo(() => {
    const history = usageHistory()
    return history
      ? selectedAllowanceCheckpoints(history.checkpoints, history.control)
      : []
  })
  const latestCheckpoint = createMemo(
    () =>
      [...activeCheckpoints()].sort(
        (left, right) => right.capturedAt - left.capturedAt,
      )[0],
  )
  const runway = createMemo(() => {
    const now = snapshot()?.refreshedAt
    return now === undefined
      ? undefined
      : allowanceRunway(activeCheckpoints(), now)
  })
  const allowanceIsStale = createMemo(() => {
    const checkpoint = latestCheckpoint()
    const now = snapshot()?.refreshedAt
    return (
      checkpoint !== undefined &&
      now !== undefined &&
      now - checkpoint.capturedAt > MAX_ALLOWANCE_CHECKPOINT_AGE_MS
    )
  })
  const targetRemaining = createMemo(() => runway()?.targetRemainingPercent)
  const controllerPolicy = createMemo(() => {
    const now = snapshot()?.refreshedAt
    return now === undefined ? undefined : usagePolicy(activeCheckpoints(), now)
  })
  const runwayDelta = createMemo(() => {
    const activeRunway = runway()
    return activeRunway
      ? activeRunway.latest.remainingPercent -
          activeRunway.targetRemainingPercent
      : undefined
  })
  const reconstructedAllowance = createMemo(() =>
    reconstructChatGptSharedHistory(usageHistory()?.checkpoints ?? []),
  )
  const chartCheckpoints = createMemo(() => reconstructedAllowance().points)
  const codexChartCheckpoints = createMemo((): readonly AllowanceChartPoint[] =>
    (usageHistory()?.checkpoints ?? [])
      .filter(
        checkpoint =>
          checkpoint.provider === "openai" &&
          checkpoint.pool === "codex-app-server-weekly",
      )
      .map(checkpoint => ({
        capturedAt: checkpoint.capturedAt,
        remainingPercent: checkpoint.remainingPercent,
        resetAt: checkpoint.resetAt,
        evidence: "observed" as const,
      })),
  )
  const combinedChartCheckpoints = createMemo(() => [
    ...chartCheckpoints(),
    ...codexChartCheckpoints(),
  ])
  const chartEvents = createMemo(() =>
    chartCheckpoints().filter(checkpoint => checkpoint.event !== undefined),
  )
  const chartDomain = createMemo(() =>
    allowanceChartDomain(combinedChartCheckpoints()),
  )
  const chartX = (capturedAt: number): number =>
    allowanceChartX(capturedAt, chartDomain())
  const chartCapacityPercent = createMemo(() => {
    const maximumRemaining = Math.max(
      100,
      ...combinedChartCheckpoints().map(
        checkpoint => checkpoint.remainingPercent,
      ),
    )

    return Math.ceil(maximumRemaining / 100) * 100
  })
  const allowanceY = (remainingPercent: number): number =>
    Math.max(
      0,
      Math.min(
        28,
        ((chartCapacityPercent() - remainingPercent) / chartCapacityPercent()) *
          28,
      ),
    )
  const allowancePolylines = createMemo(() =>
    allowanceChartSegments(chartCheckpoints())
      .filter(segment => segment.length > 1)
      .map(segment =>
        segment
          .map(
            ({ capturedAt, remainingPercent }) =>
              `${chartX(capturedAt)},${allowanceY(remainingPercent)}`,
          )
          .join(" "),
      ),
  )
  const codexAllowancePolylines = createMemo(() =>
    allowanceChartSegments(codexChartCheckpoints())
      .filter(segment => segment.length > 1)
      .map(segment =>
        segment
          .map(
            ({ capturedAt, remainingPercent }) =>
              `${chartX(capturedAt)},${allowanceY(remainingPercent)}`,
          )
          .join(" "),
      ),
  )
  const allowanceTargetPolyline = createMemo(() => {
    const activeRunway = runway()
    if (!activeRunway) return ""
    const startY = allowanceY(activeRunway.anchor.remainingPercent)
    return `${chartX(activeRunway.anchor.capturedAt)},${startY} 100,28`
  })
  const allowanceNowX = createMemo(() => {
    const now = snapshot()?.refreshedAt
    return now === undefined ? 0 : chartX(now)
  })
  const allowanceEventLabel = (
    event: AllowanceHistoryEvent | undefined,
  ): string =>
    event === "cycle-start"
      ? "Start 100 · est."
      : event === "provider-reset"
        ? "Reset 100 · est."
        : event === "exhaustion"
          ? "Zero · est."
          : event === "bailout"
            ? "Bailout 100 · reported"
            : ""
  const allowanceEventDetail = (
    event: AllowanceHistoryEvent | undefined,
  ): string =>
    event === "cycle-start"
      ? "Estimated cycle start from the reported weekly reset"
      : event === "provider-reset"
        ? "Random provider reset, estimated between the 65% and 94% observations"
        : event === "exhaustion"
          ? "Exhaustion to 0%, estimated shortly before the bailout"
          : event === "bailout"
            ? "Owner-reported bailout to 100%; timestamp is accurate to the reported minute"
            : ""
  const activeAllowanceLabel = createMemo(() => {
    const checkpoint = latestCheckpoint()
    return checkpoint
      ? allowancePoolLabel(checkpoint)
      : activePool() === "codex-app-server-weekly"
        ? "Codex app-server weekly"
        : "ChatGPT shared weekly"
  })
  const allowanceMethodology =
    "Both OpenAI allowance pools share this time axis but remain separate series. Codex uses provider app-server samples plus owner-verified UI checkpoints; ChatGPT uses its own manual history. The dashed target and burn controller follow only the active pool selected by /v1/usage/control. Flat samples count as zero burn, recent intervals are time-weighted, and pools are never merged."
  const actualRemainingLabel = createMemo(() => {
    const checkpoint = latestCheckpoint()
    return checkpoint ? `${checkpoint.remainingPercent}%` : "—"
  })
  const targetLabel = createMemo(() => {
    const target = targetRemaining()
    return target === undefined
      ? "Needs current sample"
      : `${target.toFixed(1)}%`
  })
  const runwayLabel = createMemo(() => {
    if (allowanceIsStale())
      return "Historical samples only · live balance and target unavailable"
    const delta = runwayDelta()
    const activeRunway = runway()
    if (delta === undefined || !activeRunway)
      return "No current verified allowance checkpoint"
    const first = activeCheckpoints().toSorted(
      (left, right) => left.capturedAt - right.capturedAt,
    )[0]
    const rebaseLabel =
      first && activeRunway.anchor.capturedAt !== first.capturedAt
        ? " · allowance bump rebased"
        : ""
    return `${
      delta < 0
        ? `${Math.abs(delta).toFixed(1)} points behind runway`
        : `${delta.toFixed(1)} points ahead of runway`
    }${rebaseLabel}`
  })
  const throttleLabel = createMemo(() => {
    const pausedRoles = usageHistory()?.control.activity?.pausedRoles ?? []
    if (pausedRoles.length > 0)
      return `${pausedRoles.length} provider roles throttled`
    const controller = controllerPolicy()
    return controller
      ? `${(controller.throttleRatio * 100).toFixed(1)}% autonomous budget`
      : "Controller awaiting sample"
  })
  const burnLabel = createMemo(() => {
    const activity = usageHistory()?.control.activity
    if (activity && activity.pausedRoles.length > 0)
      return `${activity.counts.deferred} deferrals · ${activity.pausedRoles.map(({ role }) => role).join(", ")}`
    const controller = controllerPolicy()
    return controller?.observedBurnPercentPerHour === undefined ||
      controller.permittedBurnPercentPerHour === undefined
      ? "Burn estimate unavailable"
      : `${controller.observedBurnPercentPerHour.toFixed(2)}%/h observed · ${controller.permittedBurnPercentPerHour.toFixed(2)}%/h permitted`
  })
  const resetLabel = createMemo(() => {
    const checkpoint = latestCheckpoint()
    const now = snapshot()?.refreshedAt
    if (checkpoint && now !== undefined && allowanceIsStale())
      return `Last verified ${relativeTime(checkpoint.capturedAt, now)}`
    return checkpoint
      ? `resets ${new Date(checkpoint.resetAt).toLocaleString([], {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}`
      : "record allowance to activate pacing"
  })
  const error = createMemo(() =>
    snapshot.loading || snapshot() !== undefined
      ? undefined
      : "Control plane is unavailable. Retrying automatically.",
  )
  const waiting = createMemo(() =>
    jobs().filter(
      ({ state }) =>
        state === "scheduled" || state === "ready" || state === "retry_wait",
    ),
  )
  const attention = createMemo(() =>
    jobs().filter(({ state }) => state === "failed" || state === "retry_wait"),
  )
  const terminal = createMemo(() =>
    jobs().filter(
      ({ state }) =>
        state === "succeeded" || state === "failed" || state === "cancelled",
    ),
  )
  const refreshedLabel = createMemo(() => {
    const timestamp = snapshot()?.refreshedAt
    return timestamp === undefined
      ? "Awaiting state"
      : `Updated ${relativeTime(timestamp)}`
  })
  const orderedJobs = createMemo(() =>
    [...jobs()].sort((left, right) => {
      const rank = (state: JobState): number =>
        state === "leased"
          ? 0
          : state === "ready"
            ? 1
            : state === "retry_wait"
              ? 2
              : 3
      return (
        rank(left.state) - rank(right.state) || right.updatedAt - left.updatedAt
      )
    }),
  )
  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="mark" aria-hidden="true">
            <span>π</span>
          </div>
          <div>
            <p class="eyebrow">LOCAL AGENT INFRASTRUCTURE</p>
            <h1>Control plane</h1>
          </div>
        </div>
        <div class="topbar-actions">
          <div
            class="health-pill"
            classList={{ offline: health()?.status !== "ok" }}
          >
            <span class="health-dot" />
            {health()?.status === "ok" ? "Runtime healthy" : "Connecting"}
          </div>
          <button
            class="refresh"
            type="button"
            onClick={() => void refetch()}
            disabled={snapshot.loading}
          >
            <span aria-hidden="true">↻</span>
            {snapshot.loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      <main>
        <section class="runtime-strip" aria-label="Runtime metadata">
          <div>
            <p class="eyebrow">DURABLE JOB RUNTIME</p>
            <h2>Fleet overview</h2>
          </div>
          <div class="runtime-meta">
            <span>Protocol v{health()?.protocolVersion ?? "—"}</span>
            <span>Schema v{health()?.schemaVersion ?? "—"}</span>
            <span>{refreshedLabel()}</span>
          </div>
        </section>

        <Show when={error()}>
          <div class="notice" role="status">
            <span>!</span>
            {error()}
          </div>
        </Show>

        <section class="metrics" aria-label="Runtime summary">
          <article class="metric cyan">
            <div class="metric-icon">◉</div>
            <p>Agents online</p>
            <strong>{onlineAgents().length}</strong>
            <span>
              {unassignedRuntimes().length + bridgeEndpoints().length} inactive
              or unverified sessions excluded
            </span>
          </article>
          <article class="metric lilac">
            <div class="metric-icon">◷</div>
            <p>Waiting</p>
            <strong>{waiting().length}</strong>
            <span>scheduled or ready</span>
          </article>
          <article class="metric amber">
            <div class="metric-icon">◇</div>
            <p>Attention</p>
            <strong>{attention().length}</strong>
            <span>retrying or failed</span>
          </article>
          <article class="metric green">
            <div class="metric-icon">✓</div>
            <p>Terminal</p>
            <strong>{terminal().length}</strong>
            <span>durable outcomes</span>
          </article>
        </section>

        <section class="panel usage-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">SUBSCRIPTION RUNWAY</p>
              <h3>Fleet usage</h3>
            </div>
            <span
              class={`count sampling-${usageHistory()?.sampling.status ?? "unavailable"}`}
            >
              {usageHistory()?.sampling.status ?? "unavailable"}
            </span>
          </div>
          <div class="usage-grid">
            <div class="usage-chart">
              <div class="usage-summary">
                <div>
                  <span>Recorded tokens</span>
                  <strong>{formatTokens(recordedTokens())}</strong>
                </div>
                <div>
                  <span>Sessions retained</span>
                  <strong>{latestUsage().length}</strong>
                </div>
                <div>
                  <span>History points</span>
                  <strong>{usageTrend().length}</strong>
                </div>
              </div>
              <svg
                viewBox="0 0 100 28"
                role="img"
                aria-label="Cumulative recorded token usage"
                preserveAspectRatio="none"
              >
                <path class="chart-grid" d="M0 7H100 M0 14H100 M0 21H100" />
                <Show
                  when={trendPolyline()}
                  fallback={
                    <text x="50" y="15" class="chart-empty">
                      Waiting for durable samples
                    </text>
                  }
                >
                  <polyline class="usage-line" points={trendPolyline()} />
                </Show>
              </svg>
            </div>

            <div
              class="allowance-card"
              classList={{ stale: allowanceIsStale() }}
            >
              <div class="allowance-heading">
                <div>
                  <span>
                    {activeAllowanceLabel()}
                    <button
                      class="allowance-info"
                      type="button"
                      aria-label="Allowance chart methodology"
                      title={allowanceMethodology}
                    >
                      ?
                    </button>
                  </span>
                  <strong>{actualRemainingLabel()}</strong>
                </div>
                <div classList={{ ahead: (runwayDelta() ?? 0) < 0 }}>
                  <span>Target now</span>
                  <strong>{targetLabel()}</strong>
                </div>
              </div>
              <svg
                viewBox="0 0 100 28"
                role="img"
                aria-label="ChatGPT and Codex weekly allowance histories with active runway target"
                preserveAspectRatio="none"
              >
                <path class="chart-grid" d="M0 7H100 M0 14H100 M0 21H100" />
                <Show when={allowanceTargetPolyline()}>
                  <polyline
                    class="allowance-target"
                    points={allowanceTargetPolyline()}
                  />
                </Show>
                <For each={allowancePolylines()}>
                  {points => (
                    <polyline class="allowance-line chatgpt" points={points} />
                  )}
                </For>
                <For each={codexAllowancePolylines()}>
                  {points => (
                    <polyline class="allowance-line codex" points={points} />
                  )}
                </For>
                <For each={chartEvents()}>
                  {checkpoint => (
                    <line
                      class={`allowance-event ${checkpoint.evidence}`}
                      x1={chartX(checkpoint.capturedAt)}
                      x2={chartX(checkpoint.capturedAt)}
                      y1="0"
                      y2="28"
                    />
                  )}
                </For>
                <For each={chartCheckpoints()}>
                  {checkpoint => (
                    <ellipse
                      class={`allowance-point chatgpt ${checkpoint.evidence}${checkpoint.event ? " event" : ""}`}
                      cx={chartX(checkpoint.capturedAt)}
                      cy={allowanceY(checkpoint.remainingPercent)}
                      rx={checkpoint.event ? "0.22" : "0.12"}
                      ry={checkpoint.event ? "1.1" : "0.7"}
                    >
                      <Show when={checkpoint.event}>
                        <title>{allowanceEventDetail(checkpoint.event)}</title>
                      </Show>
                    </ellipse>
                  )}
                </For>
                <For each={codexChartCheckpoints()}>
                  {checkpoint => (
                    <ellipse
                      class="allowance-point codex observed"
                      cx={chartX(checkpoint.capturedAt)}
                      cy={allowanceY(checkpoint.remainingPercent)}
                      rx="0.12"
                      ry="0.7"
                    />
                  )}
                </For>
                <Show when={combinedChartCheckpoints().length > 0}>
                  <line
                    class="allowance-now"
                    x1={allowanceNowX()}
                    x2={allowanceNowX()}
                    y1="0"
                    y2="28"
                  />
                </Show>
              </svg>
              <div class="runway-note">
                <span>{runwayLabel()}</span>
                <span>{resetLabel()}</span>
              </div>
              <div
                class={`throttle-note${
                  (usageHistory()?.control.activity?.pausedRoles.length ?? 0) >
                  0
                    ? " active"
                    : ""
                }`}
              >
                <strong>{throttleLabel()}</strong>
                <span>{burnLabel()}</span>
              </div>
              <div
                class="allowance-events"
                aria-label="ChatGPT allowance timeline events"
              >
                <For each={chartEvents()}>
                  {checkpoint => (
                    <span class={checkpoint.evidence}>
                      {allowanceEventLabel(checkpoint.event)}
                    </span>
                  )}
                </For>
              </div>
            </div>

            <div class="project-usage">
              <p class="eyebrow">PROJECT ALLOCATION</p>
              <Show
                when={projectUsage().length > 0}
                fallback={
                  <p class="allocation-empty">No usage allocation yet.</p>
                }
              >
                <For each={projectUsage().slice(0, 6)}>
                  {({ project, tokens }) => (
                    <div class="allocation-row">
                      <div>
                        <strong>{project}</strong>
                        <span>{formatTokens(tokens)}</span>
                      </div>
                      <span class="allocation-track">
                        <span
                          style={{
                            width: `${Math.max(2, (tokens / Math.max(1, recordedTokens())) * 100)}%`,
                          }}
                        />
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </section>

        <section
          class="workspace-grid"
          classList={{ "empty-jobs": jobs().length === 0 }}
        >
          <article class="panel jobs-panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">WORK QUEUE</p>
                <h3>Agent jobs</h3>
              </div>
              <span class="count">{jobs().length} total</span>
            </div>

            <Show
              when={orderedJobs().length > 0}
              fallback={
                <div class="empty-state">
                  <span class="empty-dot" aria-hidden="true" />
                  <div>
                    <h4>No durable jobs</h4>
                    <p>Scheduled work will appear here.</p>
                  </div>
                </div>
              }
            >
              <div class="job-list">
                <For each={orderedJobs()}>
                  {job => {
                    const schedule = jobSchedulePresentation(job)
                    return (
                      <div class="job-row">
                        <div class={`state-rail ${job.state}`} />
                        <div class="job-main">
                          <div class="job-title">
                            <strong>{job.spec.payload.profile}</strong>
                            <span class={`badge ${job.state}`}>
                              {stateLabel[job.state]}
                            </span>
                          </div>
                          <p>
                            {job.spec.kind} · {job.spec.payload.task} ·{" "}
                            {job.id.slice(0, 8)}
                          </p>
                        </div>
                        <div class="job-attempt">
                          <span>Attempt</span>
                          <strong>
                            {job.attempt}/{job.spec.maxAttempts}
                          </strong>
                        </div>
                        <div
                          class="job-schedule"
                          classList={{ stale: schedule.stale }}
                        >
                          <span>{schedule.label}</span>
                          <strong>{schedule.value}</strong>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </article>

          <aside class="panel runtime-panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">LIVE FLEET</p>
                <h3>Registered agents</h3>
              </div>
              <span class="count">{onlineAgents().length} online</span>
            </div>
            <Show
              when={onlineAgents().length > 0}
              fallback={
                <p class="agent-empty">No lifecycle-verified agents.</p>
              }
            >
              <div class="agent-list">
                <For each={onlineAgents()}>
                  {agent => (
                    <div class="agent-row">
                      <span class="health-dot" />
                      <div>
                        <strong>{agent.label}</strong>
                        <p>
                          {agent.model ?? "external harness"} · {agent.cwd}
                        </p>
                        <Show
                          when={agent.activities.length > 0}
                          fallback={
                            <p class="agent-activity idle">
                              Standing by
                              {agent.roles.length > 0
                                ? ` · ${agent.roles.map(({ role }) => role).join(", ")}`
                                : ""}
                            </p>
                          }
                        >
                          <For each={agent.activities}>
                            {activity => (
                              <p class={`agent-activity ${activity.status}`}>
                                <span>
                                  {activity.status === "in_progress"
                                    ? "In progress"
                                    : activity.status === "in_review"
                                      ? "In review"
                                      : "Next"}
                                </span>
                                #{activity.todoId} {activity.text}
                              </p>
                            )}
                          </For>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show
              when={unassignedRuntimes().length + bridgeEndpoints().length > 0}
            >
              <p class="agent-empty">
                {unassignedRuntimes().length} unassigned runtimes and
                {` ${bridgeEndpoints().length} `}monitor-only bridge endpoints
                are excluded from the live-agent total.
              </p>
            </Show>
            <div class="read-only-note">
              <span>VIEW ONLY</span>
              Browser controls remain disabled until each command has a reviewed
              typed boundary.
            </div>
          </aside>
        </section>
      </main>

      <footer>
        <span>Pi local control plane</span>
        <span class="footer-rule" />
        <span>loopback only · no ambient authority</span>
      </footer>
    </div>
  )
}

const root = document.querySelector("#root")
if (root instanceof HTMLElement) render(() => <App />, root)
else document.body.textContent = "Pi control-plane dashboard could not mount."
