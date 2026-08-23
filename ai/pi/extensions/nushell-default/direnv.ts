import { existsSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"

import type { BashSpawnContext } from "@earendil-works/pi-coding-agent"

export type DirenvExport = Readonly<Record<string, string | null>>

export type DirenvExportDecodeResult =
  | { readonly ok: true; readonly value: DirenvExport }
  | { readonly ok: false; readonly reason: string }

export type PathExists = (path: string) => boolean
export type PathIsFile = (path: string) => boolean

export interface DirenvExportProcessInput {
  readonly direnvPath: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
}

export interface DirenvExportProcessResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly failure?: "aborted" | "timeout" | "spawn" | "output"
}

export type DirenvExportRunner = (
  input: DirenvExportProcessInput,
) => Promise<DirenvExportProcessResult>

export type DirenvEnvironmentLoadResult =
  | {
      readonly ok: true
      readonly source: "none" | "explicit" | "direnv"
      readonly context: BashSpawnContext
      readonly exported?: DirenvExport
    }
  | { readonly ok: false; readonly reason: string }

export interface DirenvEnvironmentLoader {
  load(
    context: BashSpawnContext,
    signal?: AbortSignal,
  ): Promise<DirenvEnvironmentLoadResult>
}

export interface DirenvEnvironmentLoaderOptions {
  readonly direnvPath: string
  readonly runExport: DirenvExportRunner
  readonly pathExists?: PathExists
  readonly pathIsFile?: PathIsFile
  readonly envrcMtimeMs?: (path: string) => number | undefined
  readonly now?: () => number
  readonly cacheTtlMs?: number
}

const MAX_EXPORT_KEYS = 512
const MAX_PROCESS_STDOUT_BYTES = 1_100_000
const DIRENV_EXPORT_TIMEOUT_MS = 60_000
const PROCESS_KILL_GRACE_MS = 1_000
const MAX_EXPORT_KEY_LENGTH = 128
const MAX_EXPORT_VALUE_BYTES = 65_536
const MAX_EXPORT_TOTAL_BYTES = 1_048_576
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const OBJECT_META_KEYS = new Set(["__proto__", "constructor", "prototype"])
const PROTECTED_ENVIRONMENT_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_"])

export class DirenvUnavailableError extends Error {
  readonly name = "DirenvUnavailableError"
}

export const resolveDirenvPath = (
  home: string | undefined,
  pathExists: (path: string) => boolean = existsSync,
): string => {
  const managedPaths = [
    "/run/current-system/sw/bin/direnv",
    ...(home ? [`${home}/.nix-profile/bin/direnv`] : []),
  ]
  const path = managedPaths.find(pathExists)
  if (path) return path
  throw new DirenvUnavailableError("direnv executable was not found")
}

const defaultPathIsFile: PathIsFile = path => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const defaultMtimeMs = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

const killProcessGroup = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void => {
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    child.kill(signal)
  }
}

export const runDirenvExportProcess: DirenvExportRunner = input =>
  new Promise(resolve => {
    if (input.signal?.aborted) {
      resolve({ exitCode: null, stdout: "", failure: "aborted" })
      return
    }

    let stdout = ""
    let failure: DirenvExportProcessResult["failure"]
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(input.direnvPath, ["export", "json"], {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      input.signal?.removeEventListener("abort", onAbort)
      resolve({ exitCode, stdout, ...(failure ? { failure } : {}) })
    }
    const terminate = (reason: NonNullable<typeof failure>): void => {
      if (settled || failure) return
      failure = reason
      killProcessGroup(child, "SIGTERM")
      killTimer = setTimeout(
        () => killProcessGroup(child, "SIGKILL"),
        PROCESS_KILL_GRACE_MS,
      )
      killTimer.unref()
    }
    const onAbort = (): void => terminate("aborted")
    const timeoutTimer = setTimeout(
      () => terminate("timeout"),
      DIRENV_EXPORT_TIMEOUT_MS,
    )
    timeoutTimer.unref()
    input.signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return
      stdout += chunk.toString("utf8")
      if (Buffer.byteLength(stdout, "utf8") > MAX_PROCESS_STDOUT_BYTES)
        terminate("output")
    })
    child.stderr?.resume()
    child.once("error", () => {
      failure = "spawn"
      finish(null)
    })
    child.once("close", exitCode => finish(exitCode))
  })

export const findNearestGitRoot = (
  cwd: string,
  pathExists: PathExists = existsSync,
): string | undefined => {
  let directory = cwd
  while (true) {
    if (pathExists(join(directory, ".git"))) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export const findNearestEnvrcDirectory = (
  cwd: string,
  pathIsFile: PathIsFile = defaultPathIsFile,
  boundary?: string,
): string | undefined => {
  let directory = cwd
  while (true) {
    if (pathIsFile(join(directory, ".envrc"))) return directory
    if (directory === boundary) return undefined
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

const stripQuotedAndCommentText = (command: string): string => {
  let result = ""
  let quote: "'" | '"' | "`" | undefined
  let escaped = false
  let comment = false

  for (const character of command) {
    if (comment) {
      if (character === "\n") {
        comment = false
        result += character
      } else {
        result += " "
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\" && quote !== "'") escaped = true
      else if (character === quote) quote = undefined
      result += character === "\n" ? "\n" : " "
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      result += " "
      continue
    }
    if (character === "#") {
      comment = true
      result += " "
      continue
    }
    result += character
  }
  return result
}

export const commandManagesOwnEnvironment = (command: string): boolean =>
  /(?:^|[\n;|])\s*\^?(?:direnv\s+(?:exec|export)\b|nix\s+develop\b)/m.test(
    stripQuotedAndCommentText(command),
  )

const invalidExport = (reason: string): DirenvExportDecodeResult => ({
  ok: false,
  reason,
})

export const decodeDirenvExport = (raw: string): DirenvExportDecodeResult => {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return invalidExport("direnv returned malformed JSON")
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    return invalidExport("direnv export must be an environment object")
  }

  const entries = Object.entries(decoded)
  if (entries.length > MAX_EXPORT_KEYS)
    return invalidExport("direnv export contains too many variables")

  let totalBytes = 0
  const value: Record<string, string | null> = {}
  for (const [key, candidate] of entries) {
    if (
      key.length > MAX_EXPORT_KEY_LENGTH ||
      !ENVIRONMENT_KEY.test(key) ||
      OBJECT_META_KEYS.has(key)
    ) {
      return invalidExport("direnv export contains an invalid variable name")
    }
    if (candidate !== null && typeof candidate !== "string")
      return invalidExport("direnv export contains a non-string value")

    const valueBytes =
      candidate === null ? 0 : Buffer.byteLength(candidate, "utf8")
    if (valueBytes > MAX_EXPORT_VALUE_BYTES)
      return invalidExport("direnv export contains an oversized value")
    totalBytes += Buffer.byteLength(key, "utf8") + valueBytes
    if (totalBytes > MAX_EXPORT_TOTAL_BYTES)
      return invalidExport("direnv export is too large")
    value[key] = candidate
  }

  return { ok: true, value }
}

const environmentKeyIsProtected = (key: string): boolean =>
  key.startsWith("PI_") || PROTECTED_ENVIRONMENT_KEYS.has(key)

const direnvEvaluationEnvironment = (
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const env = { ...environment }
  delete env.DIRENV_DIFF
  delete env.DIRENV_WATCHES
  delete env.IN_NIX_SHELL
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_")) delete env[key]
  }
  return env
}

export const createDirenvEnvironmentLoader = (
  options: DirenvEnvironmentLoaderOptions,
): DirenvEnvironmentLoader => {
  const pathExists = options.pathExists ?? existsSync
  const pathIsFile = options.pathIsFile ?? defaultPathIsFile
  const envrcMtimeMs = options.envrcMtimeMs ?? defaultMtimeMs
  const now = options.now ?? Date.now
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 2_000)
  const cache = new Map<
    string,
    {
      readonly mtimeMs: number
      readonly expiresAt: number
      readonly exported: DirenvExport
    }
  >()

  return {
    async load(context, signal) {
      if (commandManagesOwnEnvironment(context.command))
        return { ok: true, source: "explicit", context }

      const gitRoot = findNearestGitRoot(context.cwd, pathExists)
      const envrcDirectory = findNearestEnvrcDirectory(
        context.cwd,
        pathIsFile,
        gitRoot,
      )
      if (!envrcDirectory) return { ok: true, source: "none", context }

      const envrcPath = join(envrcDirectory, ".envrc")
      const mtimeMs = envrcMtimeMs(envrcPath)
      if (mtimeMs === undefined)
        return {
          ok: false,
          reason: `direnv could not stat ${envrcPath}`,
        }

      const cached = cache.get(envrcPath)
      const currentTime = now()
      if (cached?.mtimeMs === mtimeMs && cached.expiresAt >= currentTime) {
        return {
          ok: true,
          source: "direnv",
          context: applyDirenvEnvironment(context, cached.exported),
          exported: cached.exported,
        }
      }

      const result = await options.runExport({
        direnvPath: options.direnvPath,
        cwd: envrcDirectory,
        env: direnvEvaluationEnvironment(context.env),
        signal,
      })
      if (result.exitCode !== 0) {
        if (result.failure === "aborted")
          return { ok: false, reason: "direnv evaluation was aborted" }
        return { ok: true, source: "none", context }
      }

      const decoded = decodeDirenvExport(result.stdout)
      if (!decoded.ok) return { ok: true, source: "none", context }
      cache.set(envrcPath, {
        mtimeMs,
        expiresAt: currentTime + cacheTtlMs,
        exported: decoded.value,
      })
      return {
        ok: true,
        source: "direnv",
        context: applyDirenvEnvironment(context, decoded.value),
        exported: decoded.value,
      }
    },
  }
}

export const applyDirenvEnvironment = (
  context: BashSpawnContext,
  exported: DirenvExport,
): BashSpawnContext => {
  const env = { ...context.env }
  for (const [key, value] of Object.entries(exported)) {
    if (environmentKeyIsProtected(key)) continue
    if (value === null) delete env[key]
    else env[key] = value
  }
  return { command: context.command, cwd: context.cwd, env }
}
