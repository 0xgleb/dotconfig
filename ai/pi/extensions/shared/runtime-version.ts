import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const MANAGED_CONFIG_GENERATION = "2026.07.23.136"
export const RUNTIME_VERSION_REQUEST_EVENT = "pi:runtime-version-request"

export const piHostRuntimeVersions = (
  entrypoint: string | undefined,
): Readonly<Record<string, string>> => {
  const hostVersion =
    entrypoint?.match(/pi-coding-agent-([0-9.]+)/)?.[1] ?? "unknown"
  const hostBuild =
    entrypoint?.match(/\/nix\/store\/([a-z0-9]+)-pi-coding-agent-/)?.[1] ??
    "unknown"
  return { "pi-host": hostVersion, "pi-host-build": hostBuild }
}
export type RuntimeVersionReporter = (
  component: string,
  version: string,
) => void

const dottedNumericVersion = /^[0-9]+(?:\.[0-9]+)+$/

export const latestRuntimeVersion = (
  current: string | undefined,
  candidate: string,
): string => {
  if (!current || current === "unknown") return candidate
  if (candidate === "unknown" || candidate === current) return current
  if (
    dottedNumericVersion.test(current) &&
    dottedNumericVersion.test(candidate)
  ) {
    const currentParts = current.split(".").map(Number)
    const candidateParts = candidate.split(".").map(Number)
    const length = Math.max(currentParts.length, candidateParts.length)
    for (let index = 0; index < length; index += 1) {
      const currentPart = currentParts[index] ?? 0
      const candidatePart = candidateParts[index] ?? 0
      if (candidatePart > currentPart) return candidate
      if (candidatePart < currentPart) return current
    }
    return current
  }
  return candidate
}

const isRuntimeVersionReporter = (
  value: unknown,
): value is RuntimeVersionReporter => typeof value === "function"

export const registerRuntimeVersion = (
  pi: ExtensionAPI,
  component: string,
  version: string,
): void => {
  pi.events.on(RUNTIME_VERSION_REQUEST_EVENT, report => {
    if (isRuntimeVersionReporter(report)) report(component, version)
  })
}
