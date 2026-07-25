import { globSync, lstatSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const GIB = 1024n ** 3n;
const PI_LOG_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RESULT_LINK = /^result(?:-\d+)?$/;
const PI_TEMP_LOG = /^pi-bash-[a-f0-9]+\.log$/;

export const CRITICAL_FREE_BYTES = 32n * GIB;
export const WARNING_FREE_BYTES = 64n * GIB;
export const CRITICAL_FREE_MEMORY_BYTES = 8n * GIB;
export const WARNING_FREE_MEMORY_BYTES = 12n * GIB;

export type ResourcePressureDecision =
  | { verdict: "allow" }
  | { verdict: "block"; reason: "disk pressure" | "memory pressure" };

export interface ProcessRssAggregate {
  readonly command: string;
  readonly count: number;
  readonly rssMiB: number;
}

export interface MemoryPressureCapacity {
  readonly totalBytes: bigint;
  readonly availablePercent: number;
  readonly availableBytes: bigint;
}

export const parseMemoryPressureCapacity = (output: string): MemoryPressureCapacity | undefined => {
  const totalMatch = output.match(/system has\s+(\d+)\s+\(/i);
  const percentMatch = output.match(/memory free percentage:\s*(\d+)%/i);
  if (!totalMatch?.[1] || !percentMatch?.[1]) return undefined;
  const totalBytes = BigInt(totalMatch[1]);
  const availablePercent = Number(percentMatch[1]);
  if (totalBytes <= 0n || !Number.isSafeInteger(availablePercent) || availablePercent < 0 || availablePercent > 100) {
    return undefined;
  }
  return {
    totalBytes,
    availablePercent,
    availableBytes: (totalBytes * BigInt(availablePercent)) / 100n,
  };
};

export const aggregateProcessRss = (output: string, limit = 8): ProcessRssAggregate[] => {
  const aggregates = new Map<string, { count: number; rssKiB: number }>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const rssKiB = Number(match[1]);
    const command = match[2]?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) ?? "";
    if (!Number.isSafeInteger(rssKiB) || rssKiB < 0 || !command) continue;
    const prior = aggregates.get(command) ?? { count: 0, rssKiB: 0 };
    aggregates.set(command, { count: prior.count + 1, rssKiB: prior.rssKiB + rssKiB });
  }
  return [...aggregates.entries()]
    .map(([command, aggregate]) => ({
      command,
      count: aggregate.count,
      rssMiB: Math.ceil(aggregate.rssKiB / 1_024),
    }))
    .sort((left, right) => right.rssMiB - left.rssMiB || left.command.localeCompare(right.command))
    .slice(0, Math.max(0, limit));
};

const TARGETED_BUN_TEST = /^(?:\s*cd\s+\/[^;&|`\s]+\s*&&)?\s*bun\s+test\s+[^;&|`\s]+\.(?:test|spec)\.[cm]?[jt]sx?\s*$/i;

export const isExpensiveCommand: (command: string) => boolean = (command) =>
  !TARGETED_BUN_TEST.test(command) &&
  /(?:^|[;&|()]|\bsudo\s+)(?:\s*)(?:darwin-rebuild\s+(?:build|switch)|nixos-rebuild\s+(?:build|switch)|nix\s+(?:build|develop|flake\s+check)|cargo\s+(?:build|test|clippy|nextest)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test)|forge\s+(?:build|test)|docker\s+build|terraform\s+(?:plan|apply)|make(?:\s|$))/i.test(
    command,
  );

export const resourcePressureDecision: (
  command: string,
  freeDiskBytes: bigint,
  freeMemoryBytes: bigint,
) => ResourcePressureDecision = (command, freeDiskBytes, freeMemoryBytes) => {
  if (!isExpensiveCommand(command)) return { verdict: "allow" };
  if (freeDiskBytes < CRITICAL_FREE_BYTES) return { verdict: "block", reason: "disk pressure" };
  if (freeMemoryBytes < CRITICAL_FREE_MEMORY_BYTES) return { verdict: "block", reason: "memory pressure" };
  return { verdict: "allow" };
};

export const diskPressureDecision: (command: string, freeBytes: bigint) => ResourcePressureDecision = (
  command,
  freeBytes,
) => resourcePressureDecision(command, freeBytes, CRITICAL_FREE_MEMORY_BYTES);

export const isStalePiTempLog: (
  path: string,
  tempRoot: string,
  modifiedAt: number,
  now: number,
) => boolean = (path, tempRoot, modifiedAt, now) =>
  resolve(dirname(path)) === resolve(tempRoot) &&
  PI_TEMP_LOG.test(basename(path)) &&
  now - modifiedAt > PI_LOG_RETENTION_MS;

export const cleanupStalePiTempLogs: (tempRoot: string, now?: number) => string[] = (
  tempRoot,
  now = Date.now(),
) => {
  const removed: string[] = [];
  for (const name of globSync("pi-bash-*.log", { cwd: tempRoot })) {
    if (!PI_TEMP_LOG.test(name)) continue;
    const path = join(tempRoot, name);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || !isStalePiTempLog(path, tempRoot, metadata.mtimeMs, now)) continue;
    unlinkSync(path);
    removed.push(name);
  }
  return removed;
};

export const resultSymlinkNames: (cwd: string) => Set<string> = (cwd) =>
  new Set(
    globSync("result*", { cwd }).filter((name) => RESULT_LINK.test(name) && lstatSync(join(cwd, name)).isSymbolicLink()),
  );

export const cleanupNewResultSymlinks: (cwd: string, before: ReadonlySet<string>) => string[] = (
  cwd,
  before,
) => {
  const removed: string[] = [];
  for (const name of resultSymlinkNames(cwd)) {
    if (before.has(name)) continue;
    const path = join(cwd, name);
    if (!lstatSync(path).isSymbolicLink()) continue;
    unlinkSync(path);
    removed.push(name);
  }
  return removed;
};

export const formatFreeBytes: (bytes: bigint) => string = (bytes) => `${bytes / GIB} GiB`;
