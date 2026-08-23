import { spawnSync } from "node:child_process"
import { freemem } from "node:os"

export interface MemoryPressureCapacity {
  readonly totalBytes: bigint
  readonly availablePercent: number
  readonly availableBytes: bigint
}

interface MemoryPressureProbeResult {
  readonly status: number | null
  readonly stdout: string
}

interface MemoryCapacityDependencies {
  readonly platform?: NodeJS.Platform
  readonly freeMemoryBytes?: () => number
  readonly memoryPressureProbe?: () => MemoryPressureProbeResult
}

export const parseMemoryPressureCapacity = (
  output: string,
): MemoryPressureCapacity | undefined => {
  const totalMatch = output.match(/system has\s+(\d+)\s+\(/i)
  const percentMatch = output.match(/memory free percentage:\s*(\d+)%/i)
  if (!totalMatch?.[1] || !percentMatch?.[1]) return undefined
  const totalBytes = BigInt(totalMatch[1])
  const availablePercent = Number(percentMatch[1])
  if (
    totalBytes <= 0n ||
    !Number.isSafeInteger(availablePercent) ||
    availablePercent < 0 ||
    availablePercent > 100
  ) {
    return undefined
  }
  return {
    totalBytes,
    availablePercent,
    availableBytes: (totalBytes * BigInt(availablePercent)) / 100n,
  }
}

const defaultMemoryPressureProbe = (): MemoryPressureProbeResult => {
  const result = spawnSync("/usr/bin/memory_pressure", ["-Q"], {
    encoding: "utf8",
    maxBuffer: 16 * 1_024,
    timeout: 5_000,
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  }
}

export const availableMemoryBytes = (
  dependencies: MemoryCapacityDependencies = {},
): bigint => {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return BigInt((dependencies.freeMemoryBytes ?? freemem)())
  }
  const result = (
    dependencies.memoryPressureProbe ?? defaultMemoryPressureProbe
  )()
  if (result.status !== 0)
    throw new Error("macOS available-memory probe failed")
  const capacity = parseMemoryPressureCapacity(result.stdout)
  if (!capacity)
    throw new Error("macOS available-memory probe returned an unknown format")
  return capacity.availableBytes
}
