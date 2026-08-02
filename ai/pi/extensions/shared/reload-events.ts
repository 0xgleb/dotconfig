export const AUTO_RELOAD_PENDING_REQUEST_EVENT = "pi:auto-reload-pending-request";
export type AutoReloadPendingReporter = (pending: boolean) => void;

export const AUTO_RELOAD_ACTIVITY_REQUEST_EVENT =
  "pi:auto-reload-activity-request";
export type AutoReloadActivityReporter = (active: boolean) => void;

export const AUTO_RELOAD_PREEMPT_EVENT = "pi:auto-reload-preempt";

export interface AutoReloadPreemptRequest {
  readonly requestedAt: number;
}
