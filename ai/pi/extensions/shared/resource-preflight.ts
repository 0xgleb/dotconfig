export const RESOURCE_PREFLIGHT_REQUEST_EVENT = "pi:resource-preflight-request"

export interface ResourcePreflightSnapshot {
  readonly verdict: "allow" | "block"
  readonly reason?: "disk pressure" | "memory pressure"
  readonly diskAvailableBytes: string
  readonly diskReserveBytes: string
  readonly memoryAvailableBytes: string
  readonly memoryReserveBytes: string
  readonly checkedAt: number
}

export type ResourcePreflightReporter = (
  snapshot: ResourcePreflightSnapshot | undefined,
) => void

const GIB = 1024n ** 3n

const byteCount = (value: string): bigint | undefined =>
  /^\d+$/.test(value) ? BigInt(value) : undefined

const formatGiB = (bytes: bigint): string => {
  const hundredths = (bytes * 100n) / GIB
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")} GiB`
}

export const resourcePreflightBlockMessage = (
  snapshot: ResourcePreflightSnapshot | undefined,
): string | undefined => {
  if (snapshot?.verdict !== "block" || !snapshot.reason) return undefined
  const diskAvailable = byteCount(snapshot.diskAvailableBytes)
  const diskReserve = byteCount(snapshot.diskReserveBytes)
  const memoryAvailable = byteCount(snapshot.memoryAvailableBytes)
  const memoryReserve = byteCount(snapshot.memoryReserveBytes)
  if (
    diskAvailable === undefined ||
    diskReserve === undefined ||
    memoryAvailable === undefined ||
    memoryReserve === undefined
  )
    return "Resource pressure guard could not decode its verified capacity snapshot."

  if (snapshot.reason === "memory pressure") {
    const shortfall =
      memoryReserve > memoryAvailable ? memoryReserve - memoryAvailable : 0n
    return `Memory pressure guard: ${formatGiB(memoryAvailable)} available; ${formatGiB(memoryReserve)} reserve; ${formatGiB(shortfall)} shortfall. Follow the assigned bounded remediation; do not poll or retry the expensive command until recovery is reported.`
  }

  const shortfall =
    diskReserve > diskAvailable ? diskReserve - diskAvailable : 0n
  return `Disk pressure guard: ${formatGiB(diskAvailable)} available; ${formatGiB(diskReserve)} reserve; ${formatGiB(shortfall)} shortfall. Follow standing exact cleanup authority: inspect candidate roots with dust or Nushell \`du\`, preserve configured live outputs, remove only verified inactive rebuildable or agent-owned artifacts, independently verify the exact path after uncertain execution, then continue the blocked gate. Do not poll repeatedly or delete unrelated data.`
}

export interface ResourcePreflightRequest {
  readonly cwd: string
  readonly command: string
  readonly report: ResourcePreflightReporter
}

const RESOURCE_CAPACITY_REASON =
  /\b(?:disk|memory|resource|space|reserve|capacity)\b/i
const STALE_CAPACITY_ASSERTION =
  /\b(?:below|insufficient|low|not restored|no evidence|cannot verify|could not verify|unavailable|unclear)\b/i
const SEMANTIC_POLICY_REASON =
  /\b(?:unauthori[sz]ed|unrelated|out of scope|destructive|secret|credential|publish|deploy|mutation)\b/i

export const resourcePreflightDisprovesBlock = (
  reason: string,
  snapshot: ResourcePreflightSnapshot | undefined,
): boolean =>
  snapshot?.verdict === "allow" &&
  RESOURCE_CAPACITY_REASON.test(reason) &&
  STALE_CAPACITY_ASSERTION.test(reason) &&
  !SEMANTIC_POLICY_REASON.test(reason)
