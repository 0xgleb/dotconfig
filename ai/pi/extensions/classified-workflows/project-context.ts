import { spawnSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";

export interface RuntimeProjectContext {
  cwd: string;
  gitToplevel?: string;
  cwdRelation: "repository-root" | "inside-repository" | "outside-repository";
}

const sanitizedGitEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
};

export const describeRuntimeProjectContext = (
  cwd: string,
  gitToplevel?: string,
): RuntimeProjectContext => {
  const resolvedCwd = resolve(cwd);
  if (!gitToplevel) return { cwd: resolvedCwd, cwdRelation: "outside-repository" };

  const resolvedToplevel = resolve(gitToplevel);
  const child = relative(resolvedToplevel, resolvedCwd);
  const cwdRelation = child === ""
    ? "repository-root"
    : child !== ".." && !child.startsWith(`..${sep}`)
      ? "inside-repository"
      : "outside-repository";
  return { cwd: resolvedCwd, gitToplevel: resolvedToplevel, cwdRelation };
};

export const runtimeProjectContext = (cwd: string): RuntimeProjectContext => {
  const resolvedCwd = resolve(cwd);
  const result = spawnSync("git", ["-C", resolvedCwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  const gitToplevel = result.status === 0 ? result.stdout.trim() : undefined;
  return describeRuntimeProjectContext(resolvedCwd, gitToplevel || undefined);
};
