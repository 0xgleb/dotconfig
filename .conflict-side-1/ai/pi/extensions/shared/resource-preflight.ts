export const RESOURCE_PREFLIGHT_REQUEST_EVENT = "pi:resource-preflight-request";

export interface ResourcePreflightSnapshot {
  readonly verdict: "allow" | "block";
  readonly reason?: "disk pressure" | "memory pressure";
  readonly diskAvailableBytes: string;
  readonly diskReserveBytes: string;
  readonly memoryAvailableBytes: string;
  readonly memoryReserveBytes: string;
  readonly checkedAt: number;
}

export type ResourcePreflightReporter = (snapshot: ResourcePreflightSnapshot | undefined) => void;

export interface ResourcePreflightRequest {
  readonly cwd: string;
  readonly command: string;
  readonly report: ResourcePreflightReporter;
}

const RESOURCE_CAPACITY_REASON = /\b(?:disk|memory|resource|space|reserve|capacity)\b/i;
const STALE_CAPACITY_ASSERTION =
  /\b(?:below|insufficient|low|not restored|no evidence|cannot verify|could not verify|unavailable|unclear)\b/i;
const SEMANTIC_POLICY_REASON =
  /\b(?:unauthori[sz]ed|unrelated|out of scope|destructive|secret|credential|publish|deploy|mutation)\b/i;

export const resourcePreflightDisprovesBlock = (
  reason: string,
  snapshot: ResourcePreflightSnapshot | undefined,
): boolean =>
  snapshot?.verdict === "allow" &&
  RESOURCE_CAPACITY_REASON.test(reason) &&
  STALE_CAPACITY_ASSERTION.test(reason) &&
  !SEMANTIC_POLICY_REASON.test(reason);
