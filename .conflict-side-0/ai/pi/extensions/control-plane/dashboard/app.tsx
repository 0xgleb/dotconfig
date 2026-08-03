import { createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import { Effect, Either } from "effect"
import { decodeStoredJob, type Job } from "../job-runtime.ts"

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

const stateLabel: Readonly<Record<JobState, string>> = {
  scheduled: "Scheduled",
  ready: "Ready",
  leased: "Running",
  retry_wait: "Retry wait",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
}

const relativeTime = (timestamp: number, now = Date.now()): string => {
  const delta = timestamp - now
  const absoluteMinutes = Math.max(1, Math.round(Math.abs(delta) / 60_000))
  const duration =
    absoluteMinutes < 60
      ? `${absoluteMinutes}m`
      : absoluteMinutes < 1_440
        ? `${Math.round(absoluteMinutes / 60)}h`
        : `${Math.round(absoluteMinutes / 1_440)}d`
  return delta >= 0 ? `in ${duration}` : `${duration} ago`
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
  ) return undefined
  return {
    status: "ok",
    protocolVersion: Number(value.protocolVersion),
    schemaVersion: Number(value.schemaVersion),
  }
}

const decodeJobs = (value: unknown): readonly Job[] | undefined => {
  if (!isRecord(value) || !Array.isArray(value.jobs)) return undefined
  const decoded = value.jobs.map((candidate) =>
    Effect.runSync(Effect.either(decodeStoredJob(candidate))),
  )
  if (decoded.some(Either.isLeft)) return undefined
  return decoded.flatMap((result) =>
    Either.isRight(result) ? [result.right] : [],
  )
}

const fetchJson = async (path: string): Promise<ApiResult> =>
  fetch(path, { headers: { accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) return { ok: false as const }
      const value: unknown = await response.json()
      return { ok: true as const, value }
    })
    .catch(() => ({ ok: false as const }))

interface DashboardSnapshot {
  readonly health: Health
  readonly jobs: readonly Job[]
  readonly refreshedAt: number
}

const fetchSnapshot = async (): Promise<DashboardSnapshot | undefined> => {
  const [healthResult, jobsResult] = await Promise.all([
    fetchJson("/v1/health"),
    fetchJson("/v1/jobs"),
  ])
  const health = healthResult.ok ? decodeHealth(healthResult.value) : undefined
  const jobs = jobsResult.ok ? decodeJobs(jobsResult.value) : undefined
  return health && jobs ? { health, jobs, refreshedAt: Date.now() } : undefined
}

const App = () => {
  const [snapshot, { refetch }] = createResource(fetchSnapshot)

  onMount(() => {
    const timer = setInterval(() => void refetch(), 5_000)
    onCleanup(() => clearInterval(timer))
  })

  const jobs = createMemo(() => snapshot()?.jobs ?? [])
  const health = createMemo(() => snapshot()?.health)
  const error = createMemo(() =>
    snapshot.loading || snapshot() !== undefined
      ? undefined
      : "Control plane is unavailable. Retrying automatically.",
  )
  const running = createMemo(() => jobs().filter(({ state }) => state === "leased"))
  const waiting = createMemo(() =>
    jobs().filter(({ state }) =>
      state === "scheduled" || state === "ready" || state === "retry_wait",
    ),
  )
  const attention = createMemo(() =>
    jobs().filter(({ state }) => state === "failed" || state === "retry_wait"),
  )
  const terminal = createMemo(() =>
    jobs().filter(({ state }) =>
      state === "succeeded" || state === "failed" || state === "cancelled",
    ),
  )
  const refreshedLabel = createMemo(() => {
    const timestamp = snapshot()?.refreshedAt
    return timestamp === undefined ? "Awaiting state" : `Updated ${relativeTime(timestamp)}`
  })
  const orderedJobs = createMemo(() =>
    [...jobs()].sort((left, right) => {
      const rank = (state: JobState): number =>
        state === "leased" ? 0 : state === "ready" ? 1 : state === "retry_wait" ? 2 : 3
      return rank(left.state) - rank(right.state) || right.updatedAt - left.updatedAt
    }),
  )

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="mark" aria-hidden="true"><span>π</span></div>
          <div>
            <p class="eyebrow">LOCAL AGENT INFRASTRUCTURE</p>
            <h1>Control plane</h1>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="health-pill" classList={{ offline: health()?.status !== "ok" }}>
            <span class="health-dot" />
            {health()?.status === "ok" ? "Runtime healthy" : "Connecting"}
          </div>
          <button class="refresh" type="button" onClick={() => void refetch()} disabled={snapshot.loading}>
            <span aria-hidden="true">↻</span>
            {snapshot.loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      <main>
        <section class="hero">
          <div>
            <p class="eyebrow">DURABLE JOB RUNTIME</p>
            <h2>Every agent job, one clear state.</h2>
            <p class="hero-copy">
              Leased execution, persisted schedules, bounded retries, and crash recovery—
              visible without handing the browser execution authority.
            </p>
          </div>
          <div class="runtime-meta">
            <span>Protocol v{health()?.protocolVersion ?? "—"}</span>
            <span>Schema v{health()?.schemaVersion ?? "—"}</span>
            <span>{refreshedLabel()}</span>
          </div>
        </section>

        <Show when={error()}>
          <div class="notice" role="status"><span>!</span>{error()}</div>
        </Show>

        <section class="metrics" aria-label="Runtime summary">
          <article class="metric cyan">
            <div class="metric-icon">◉</div>
            <p>Running</p>
            <strong>{running().length}</strong>
            <span>actively leased</span>
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

        <section class="workspace-grid">
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
                  <div class="empty-orbit"><span>·</span></div>
                  <h4>No durable jobs yet</h4>
                  <p>Registered review scans will appear here after the scheduler adapter is enabled.</p>
                </div>
              }
            >
              <div class="job-list">
                <For each={orderedJobs()}>{(job) => (
                  <div class="job-row">
                    <div class={`state-rail ${job.state}`} />
                    <div class="job-main">
                      <div class="job-title">
                        <strong>{job.spec.payload.profile}</strong>
                        <span class={`badge ${job.state}`}>{stateLabel[job.state]}</span>
                      </div>
                      <p>{job.spec.kind} · {job.id.slice(0, 8)}</p>
                    </div>
                    <div class="job-attempt">
                      <span>Attempt</span>
                      <strong>{job.attempt}/{job.spec.maxAttempts}</strong>
                    </div>
                    <div class="job-schedule">
                      <span>{job.state === "leased" ? "Lease" : "Run"}</span>
                      <strong>{relativeTime(job.state === "leased" ? job.leaseUntil ?? job.spec.runAt : job.spec.runAt)}</strong>
                    </div>
                  </div>
                )}</For>
              </div>
            </Show>
          </article>

          <aside class="panel runtime-panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">SAFETY MODEL</p>
                <h3>Runtime guarantees</h3>
              </div>
            </div>
            <ol class="guarantee-list">
              <li><span>01</span><div><strong>Persist first</strong><p>Schedules and retry decisions survive process reloads.</p></div></li>
              <li><span>02</span><div><strong>Fence every attempt</strong><p>Stale workers cannot publish a terminal outcome.</p></div></li>
              <li><span>03</span><div><strong>Registered work only</strong><p>No shell strings, arbitrary code, or approval tokens.</p></div></li>
              <li><span>04</span><div><strong>Authority stays narrow</strong><p>A lease routes work; constrained tools still decide capability.</p></div></li>
            </ol>
            <div class="read-only-note">
              <span>VIEW ONLY</span>
              Browser controls remain disabled until each command has a reviewed typed boundary.
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
