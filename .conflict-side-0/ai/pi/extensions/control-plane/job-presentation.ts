import type { Job } from "./job-runtime.ts"

const MAX_LEGACY_SCHEDULE_SKEW_MS = 7 * 24 * 60 * 60 * 1_000

export interface JobSchedulePresentation {
  readonly label: "Run" | "Lease" | "Finished"
  readonly value: string
  readonly stale: boolean
}

export const relativeTime = (timestamp: number, now = Date.now()): string => {
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

export const jobSchedulePresentation = (
  job: Job,
  now = Date.now(),
): JobSchedulePresentation => {
  if (
    job.state === "succeeded" ||
    job.state === "failed" ||
    job.state === "cancelled"
  )
    return {
      label: "Finished",
      value: relativeTime(job.finishedAt, now),
      stale: false,
    }

  if (job.state === "leased")
    return {
      label: "Lease",
      value: relativeTime(job.leaseUntil, now),
      stale: job.leaseUntil < now,
    }

  if (job.spec.runAt < job.createdAt - MAX_LEGACY_SCHEDULE_SKEW_MS)
    return { label: "Run", value: "Invalid schedule", stale: true }

  return {
    label: "Run",
    value: relativeTime(job.spec.runAt, now),
    stale: job.spec.runAt < now,
  }
}
