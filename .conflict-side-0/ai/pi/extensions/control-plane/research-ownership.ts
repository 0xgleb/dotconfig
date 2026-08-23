import { Effect } from "effect"
import type { Job } from "./job-runtime.ts"
import type { JobStoreError, SqliteJobStore } from "./sqlite-job-store.ts"

const isActiveJob = (
  job: Job,
): job is Extract<
  Job,
  { readonly state: "scheduled" | "ready" | "retry_wait" | "leased" }
> =>
  job.state === "scheduled" ||
  job.state === "ready" ||
  job.state === "retry_wait" ||
  job.state === "leased"

export const legacyAgentopsResearchJobs = (
  jobs: readonly Job[],
): readonly Job[] =>
  jobs.filter(
    job =>
      isActiveJob(job) &&
      job.spec.kind === "harness.research" &&
      job.spec.payload.ownership === undefined &&
      job.spec.payload.profile.startsWith("agentops-"),
  )

export const reconcileLegacyAgentopsResearchJobs = (
  store: SqliteJobStore,
  now: number,
): Effect.Effect<{ readonly cancelled: readonly string[] }, JobStoreError> =>
  Effect.gen(function* () {
    const jobs = yield* store.list()
    const legacy = legacyAgentopsResearchJobs(jobs)
    yield* Effect.forEach(legacy, job => store.cancel(job.id, now), {
      concurrency: 1,
      discard: true,
    })
    return { cancelled: legacy.map(({ id }) => id) }
  })
