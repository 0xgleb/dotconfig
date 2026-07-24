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
