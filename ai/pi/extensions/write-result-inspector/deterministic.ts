import { lstat as nodeLstat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { ExecResult } from "@earendil-works/pi-coding-agent"
import {
  deterministicCheckPlan,
  isProtectedWorkspacePath,
  type InspectionBatchFile,
} from "./core.ts"

const DETERMINISTIC_TIMEOUT_MS = 4_000
const MAX_CHECKED_FILE_BYTES = 1024 * 1024

export type DeterministicSkipReason =
  | "unsafe-symlink"
  | "file-missing"
  | "file-too-large"
  | "checker-unavailable"
  | "no-checker"

export interface DeterministicSkip {
  readonly path: string
  readonly reason: DeterministicSkipReason
}

export interface DeterministicFinding {
  readonly source: "deterministic"
  readonly path: string
  readonly inspector: "format-and-syntax" | "syntax" | "import"
  readonly severity: "error"
  readonly code: "deterministic-check-failed" | "forbidden-import"
  readonly message: string
}

export type DeterministicCheckOutcome =
  | { readonly status: "clean"; readonly skipped: readonly DeterministicSkip[] }
  | {
      readonly status: "findings"
      readonly findings: readonly DeterministicFinding[]
      readonly skipped: readonly DeterministicSkip[]
    }
  | { readonly status: "cancelled"; readonly skipped: readonly [] }

interface FileMetadata {
  readonly size: number
  isSymbolicLink(): boolean
}

interface DeterministicExecResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly killed: boolean
}

export interface DeterministicDependencies {
  readonly cwd: string
  readonly signal: AbortSignal | undefined
  readonly lstat: (path: string) => Promise<FileMetadata>
  readonly exec: (
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string
      readonly signal?: AbortSignal
      readonly timeout: number
    },
  ) => Promise<DeterministicExecResult>
}

const nushellIdeCheckFailed = (stdout: string): boolean =>
  stdout
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .some(line => {
      try {
        const diagnostic: unknown = JSON.parse(line)
        return (
          typeof diagnostic !== "object" ||
          diagnostic === null ||
          !("type" in diagnostic) ||
          typeof diagnostic.type !== "string" ||
          diagnostic.type === "error"
        )
      } catch {
        return true
      }
    })

const findingMessage = (
  command: "prettier" | "nix-instantiate" | "nu" | "rustfmt",
): string => {
  if (command === "prettier")
    return "The configured Prettier syntax/format check failed for this changed file."
  if (command === "nix-instantiate")
    return "The configured Nix syntax check failed for this changed file."
  if (command === "nu")
    return "The configured Nushell syntax check failed for this changed file."
  return "The configured rustfmt syntax/format check failed for this changed file."
}

const changedSourceText = (file: InspectionBatchFile): string =>
  file.exactChangedText.includes("@@ edit ")
    ? file.exactChangedText
        .split("\n")
        .filter(line => line.startsWith("+") && !line.startsWith("+++"))
        .map(line => line.slice(1))
        .join("\n")
    : file.exactChangedText

const changedImportSpecifiers = (
  file: InspectionBatchFile,
): readonly string[] => {
  if (!new Set(["typescript", "javascript", "svelte"]).has(file.language))
    return []
  const source = changedSourceText(file)
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g,
  ]
  return [
    ...new Set(
      patterns.flatMap(pattern =>
        [...source.matchAll(pattern)].flatMap(match =>
          typeof match[1] === "string" ? [match[1]] : [],
        ),
      ),
    ),
  ]
}

const outsideWorkspace = (workspace: string, target: string): boolean => {
  const child = relative(workspace, target)
  return child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)
}

const forbiddenImportFinding = (
  file: InspectionBatchFile,
  cwd: string,
): DeterministicFinding | undefined => {
  const workspace = resolve(cwd)
  for (const specifier of changedImportSpecifiers(file)) {
    if (
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("file:")
    )
      continue
    if (specifier.startsWith("file:"))
      return {
        source: "deterministic",
        path: file.path,
        inspector: "import",
        severity: "error",
        code: "forbidden-import",
        message:
          "A changed import crosses the workspace or protected-path boundary.",
      }
    const target = specifier.startsWith("/")
      ? resolve(specifier)
      : resolve(workspace, dirname(file.path), specifier)
    const child = relative(workspace, target).split(sep).join("/")
    if (outsideWorkspace(workspace, target) || isProtectedWorkspacePath(child))
      return {
        source: "deterministic",
        path: file.path,
        inspector: "import",
        severity: "error",
        code: "forbidden-import",
        message:
          "A changed import crosses the workspace or protected-path boundary.",
      }
  }
  return undefined
}

export const defaultDeterministicDependencies = (
  cwd: string,
  signal: AbortSignal | undefined,
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
  ) => Promise<ExecResult>,
): DeterministicDependencies => ({
  cwd,
  signal,
  lstat: nodeLstat,
  exec: async (command, args, options) => {
    const result = await exec(command, [...args], {
      cwd: options.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: options.timeout,
    })
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      killed: result.killed,
    }
  },
})

export const runDeterministicChecks = async (
  files: readonly InspectionBatchFile[],
  dependencies: DeterministicDependencies,
): Promise<DeterministicCheckOutcome> => {
  if (dependencies.signal?.aborted) return { status: "cancelled", skipped: [] }

  const outcomes = await Promise.all(
    files.map(async file => {
      const importFinding = forbiddenImportFinding(file, dependencies.cwd)
      if (importFinding)
        return { kind: "finding" as const, finding: importFinding }
      const absolutePath = resolve(dependencies.cwd, file.path)
      let metadata: FileMetadata
      try {
        metadata = await dependencies.lstat(absolutePath)
      } catch {
        return {
          kind: "skip" as const,
          path: file.path,
          reason: "file-missing" as const,
        }
      }
      if (metadata.isSymbolicLink())
        return {
          kind: "skip" as const,
          path: file.path,
          reason: "unsafe-symlink" as const,
        }
      if (metadata.size > MAX_CHECKED_FILE_BYTES)
        return {
          kind: "skip" as const,
          path: file.path,
          reason: "file-too-large" as const,
        }
      if (dependencies.signal?.aborted) return { kind: "cancelled" as const }

      const plan = deterministicCheckPlan(file)
      if (!plan)
        return {
          kind: "skip" as const,
          path: file.path,
          reason: "no-checker" as const,
        }

      let result: DeterministicExecResult
      try {
        result = await dependencies.exec(plan.command, plan.args, {
          cwd: dependencies.cwd,
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          timeout: DETERMINISTIC_TIMEOUT_MS,
        })
      } catch {
        if (dependencies.signal?.aborted) return { kind: "cancelled" as const }
        return {
          kind: "skip" as const,
          path: file.path,
          reason: "checker-unavailable" as const,
        }
      }
      if (dependencies.signal?.aborted || result.killed)
        return { kind: "cancelled" as const }
      if (result.code === 127)
        return {
          kind: "skip" as const,
          path: file.path,
          reason: "checker-unavailable" as const,
        }
      if (
        result.code === 0 &&
        (plan.command !== "nu" || !nushellIdeCheckFailed(result.stdout))
      )
        return { kind: "clean" as const }
      return {
        kind: "finding" as const,
        finding: {
          source: "deterministic" as const,
          path: file.path,
          inspector: plan.kind,
          severity: "error" as const,
          code: "deterministic-check-failed" as const,
          message: findingMessage(plan.command),
        },
      }
    }),
  )

  if (outcomes.some(outcome => outcome.kind === "cancelled"))
    return { status: "cancelled", skipped: [] }
  const skipped = outcomes.flatMap(outcome =>
    outcome.kind === "skip"
      ? [{ path: outcome.path, reason: outcome.reason }]
      : [],
  )
  const findings = outcomes.flatMap(outcome =>
    outcome.kind === "finding" ? [outcome.finding] : [],
  )
  return findings.length > 0
    ? { status: "findings", findings, skipped }
    : { status: "clean", skipped }
}

export const shouldRunLuna = (
  outcome: DeterministicCheckOutcome,
  files: readonly InspectionBatchFile[],
): boolean =>
  outcome.status === "clean" &&
  outcome.skipped.length === 0 &&
  files.some(file => file.inspectors.length > 0)
