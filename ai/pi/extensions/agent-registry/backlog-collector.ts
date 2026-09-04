import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import {
  delimiter,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path"
import { Data, Effect, Option } from "effect"

import {
  backlogDocumentSnapshot,
  githubTrackerSnapshot,
  type GitHubTrackerItemInput,
} from "../shared/backlog-source-adapters.ts"
import type { CanonicalBacklogSnapshot } from "../shared/backlog-events.ts"

const MAX_MANIFEST_BYTES = 16 * 1_024
const MAX_DOCUMENT_BYTES = 4 * 1_024 * 1_024
const MAX_GITHUB_ITEMS = 5_000
const MAX_GITHUB_PAGE_ITEMS = 100
const MAX_GITHUB_PAGES = Math.ceil(MAX_GITHUB_ITEMS / MAX_GITHUB_PAGE_ITEMS) + 1
const MAX_GITHUB_PAGE_BYTES = 16 * 1_024 * 1_024
const MAX_GITHUB_TOTAL_BYTES = 64 * 1_024 * 1_024
const BACKLOG_COMMAND_TIMEOUT_MS = 15_000
export const BACKLOG_COLLECTION_TIMEOUT_MS = 60_000
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const UNSAFE_GITHUB_TEXT_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const HIGH_CONFIDENCE_SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[oprsu]_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|authorization\s*:\s*bearer\s+[A-Za-z0-9._~+\/-]{12,}/i
const PROTECTED_DOCUMENT_PATH =
  /(?:^|\/)(?:\.env(?:\.|$)|credentials?\.(?:json|ya?ml)$|secrets?(?:\/|\.|$)|auth\.json$|\.npmrc$|\.netrc$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$)|\.(?:age|key|pem|p12|pfx)$/i
const GITHUB_REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

export class BacklogCollectorError extends Data.TaggedError(
  "BacklogCollectorError",
)<{
  readonly code:
    | "invalid_manifest"
    | "invalid_document_path"
    | "missing_document"
    | "source_failure"
    | "cancelled"
  readonly message: string
}> {}

export interface DeclaredGitHubBacklogSource {
  readonly repository?: string
}

export interface DeclaredBacklogCollection {
  readonly snapshots: readonly CanonicalBacklogSnapshot[]
  readonly github?: DeclaredGitHubBacklogSource
}

export type DeclaredBacklogFileReader = (
  relativePath: string,
  maxBytes: number,
) => Effect.Effect<Option.Option<string>, BacklogCollectorError>

export type DeclaredBacklogCommandKind =
  "git-origin" | "github-issues" | "github-pulls"

export interface DeclaredBacklogCommandRequest {
  readonly kind: DeclaredBacklogCommandKind
  readonly command: "git" | "gh"
  readonly args: readonly string[]
  readonly cwd: string
  readonly maxOutputBytes: number
  readonly timeoutMs: number
  readonly page?: number
}

export type DeclaredBacklogCommandRunner = (
  request: DeclaredBacklogCommandRequest,
) => Effect.Effect<string, BacklogCollectorError>

export interface CollectDeclaredGitHubBacklogInput {
  readonly project: string
  readonly declared: DeclaredGitHubBacklogSource
  readonly observedAt: number
  readonly runCommand: DeclaredBacklogCommandRunner
}

export type DeclaredGitHubCollector = (
  declared: DeclaredGitHubBacklogSource,
) => Effect.Effect<CanonicalBacklogSnapshot, BacklogCollectorError>

export interface CollectDeclaredBacklogSourcesInput {
  readonly project: string
  readonly configDirName: string
  readonly trusted: boolean
  readonly observedAt: number
  readonly readFile: DeclaredBacklogFileReader
  readonly collectGitHub?: DeclaredGitHubCollector
}

interface DeclaredBacklogSourcesManifest {
  readonly version: 1
  readonly document?: string
  readonly github?: DeclaredGitHubBacklogSource
}

const failure = (
  code: BacklogCollectorError["code"],
  message: string,
): BacklogCollectorError => new BacklogCollectorError({ code, message })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every(key => allowed.has(key))

const validDocumentPath = (value: string): boolean => {
  if (
    value.length === 0 ||
    value.length > 256 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER.test(value) ||
    PROTECTED_DOCUMENT_PATH.test(value)
  )
    return false
  const segments = value.split("/")
  return segments.every(
    segment => segment !== "" && segment !== "." && segment !== "..",
  )
}

const isInsideRoot = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !isAbsolute(fromRoot))
  )
}

const canonicalProject = (project: string): string =>
  normalize(project).replace(/\/$/u, "") || "/"

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined

const BACKLOG_COMMAND_ENVIRONMENT_KEYS = ["HOME", "LANG", "LC_ALL"] as const
const TRUSTED_EXECUTABLE_DIRECTORY =
  /^(?:\/bin|\/usr\/bin|\/run\/current-system\/sw\/bin|\/nix\/store\/[^/]+\/bin)$/u

export const safeBacklogCommandEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const inherited = Object.fromEntries(
    BACKLOG_COMMAND_ENVIRONMENT_KEYS.flatMap(key => {
      const value = environment[key]
      return typeof value === "string" && value.length > 0
        ? [[key, value] as const]
        : []
    }),
  )
  const path = (environment.PATH ?? "")
    .split(delimiter)
    .filter(entry => TRUSTED_EXECUTABLE_DIRECTORY.test(entry))
    .join(delimiter)
  return { ...inherited, ...(path ? { PATH: path } : {}) }
}

export const stopChild = (
  child: ReturnType<typeof spawn>,
  forceAfterMs = 500,
): Effect.Effect<void, never> => {
  const signal = (value: NodeJS.Signals): Effect.Effect<void, never> => {
    const pid = child.pid
    const processGroup =
      pid !== undefined && process.platform !== "win32"
        ? Effect.try({
            try: () => void process.kill(-pid, value),
            catch: () => undefined,
          })
        : Effect.fail(undefined)
    return processGroup.pipe(
      Effect.catchAll(() =>
        Effect.try({
          try: () => void child.kill(value),
          catch: () => undefined,
        }),
      ),
      Effect.catchAll(() => Effect.void),
    )
  }
  return signal("SIGTERM").pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            void Effect.runPromise(signal("SIGKILL"))
        }, forceAfterMs)
        forceTimer.unref?.()
        child.once("close", () => clearTimeout(forceTimer))
      }),
    ),
  )
}

export const makeDeclaredBacklogCommandRunner =
  (
    signal?: AbortSignal,
    deadlineAt = Number.POSITIVE_INFINITY,
  ): DeclaredBacklogCommandRunner =>
  request => {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0)
      return Effect.fail(
        failure("source_failure", "backlog collection timed out"),
      )
    return Effect.tryPromise({
      try: () =>
        new Promise<string>((resolvePromise, rejectPromise) => {
          if (signal?.aborted) {
            rejectPromise(
              failure("cancelled", "declared backlog collection was cancelled"),
            )
            return
          }
          const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            detached: process.platform !== "win32",
            env: safeBacklogCommandEnvironment(process.env),
            stdio: ["ignore", "pipe", "ignore"],
          })
          const chunks: Buffer[] = []
          let outputBytes = 0
          let settled = false
          const finish = (result: {
            readonly value?: string
            readonly error?: BacklogCollectorError
          }) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            signal?.removeEventListener("abort", onAbort)
            if (result.error) rejectPromise(result.error)
            else resolvePromise(result.value ?? "")
          }
          const onAbort = () => {
            Effect.runSync(stopChild(child))
            finish({
              error: failure(
                "cancelled",
                "declared backlog collection was cancelled",
              ),
            })
          }
          const timeout = setTimeout(
            () => {
              Effect.runSync(stopChild(child))
              finish({
                error: failure("source_failure", "backlog command timed out"),
              })
            },
            Math.min(request.timeoutMs, remainingMs),
          )
          timeout.unref?.()
          signal?.addEventListener("abort", onAbort, { once: true })
          const stdout = child.stdout
          if (!stdout) {
            Effect.runSync(stopChild(child))
            finish({
              error: failure("source_failure", "backlog command failed"),
            })
            return
          }
          stdout.on("data", (chunk: Buffer) => {
            outputBytes += chunk.byteLength
            if (outputBytes > request.maxOutputBytes) {
              Effect.runSync(stopChild(child))
              finish({
                error: failure(
                  "source_failure",
                  "backlog command output is too large",
                ),
              })
              return
            }
            chunks.push(chunk)
          })
          child.once("error", () => {
            finish({
              error: failure("source_failure", "backlog command failed"),
            })
          })
          child.once("close", code => {
            if (code !== 0) {
              finish({
                error: failure("source_failure", "backlog command failed"),
              })
              return
            }
            finish({ value: Buffer.concat(chunks).toString("utf8") })
          })
        }),
      catch: cause =>
        cause instanceof BacklogCollectorError
          ? cause
          : signal?.aborted
            ? failure("cancelled", "declared backlog collection was cancelled")
            : failure("source_failure", "backlog command failed"),
    })
  }

const canonicalGitHubRepository = (
  value: string,
): Effect.Effect<string, BacklogCollectorError> =>
  Effect.gen(function* () {
    const remote = value.trim()
    if (
      remote.length === 0 ||
      remote.length > 512 ||
      CONTROL_CHARACTER.test(remote)
    )
      return yield* Effect.fail(
        failure("source_failure", "GitHub origin is invalid"),
      )
    const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(remote)
    const scpOwner = scp?.[1]
    const scpName = scp?.[2]
    if (scpOwner && scpName) {
      const repository = `${scpOwner}/${scpName}`
      if (GITHUB_REPOSITORY.test(repository)) return repository
    }
    const parsed = yield* Effect.try({
      try: () => new URL(remote),
      catch: () => failure("source_failure", "GitHub origin is invalid"),
    })
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.port !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.protocol === "https:" && parsed.username !== "") ||
      (parsed.protocol === "ssh:" && parsed.username !== "git")
    )
      return yield* Effect.fail(
        failure("source_failure", "GitHub origin is invalid"),
      )
    const segments = parsed.pathname
      .replace(/^\//u, "")
      .replace(/\.git$/u, "")
      .split("/")
    const [owner, name] = segments
    const repository = owner && name ? `${owner}/${name}` : ""
    return segments.length === 2 && GITHUB_REPOSITORY.test(repository)
      ? repository
      : yield* Effect.fail(
          failure("source_failure", "GitHub origin is invalid"),
        )
  })

const githubLabels = (
  value: unknown,
): Effect.Effect<readonly string[], BacklogCollectorError> => {
  if (!Array.isArray(value) || value.length > 100)
    return Effect.fail(
      failure("source_failure", "GitHub tracker page is malformed"),
    )
  return Effect.forEach(value, label => {
    if (
      !isRecord(label) ||
      typeof label.name !== "string" ||
      label.name.length === 0 ||
      label.name.length > 256 ||
      UNSAFE_GITHUB_TEXT_CONTROL.test(label.name) ||
      HIGH_CONFIDENCE_SECRET.test(label.name)
    )
      return Effect.fail(
        failure("source_failure", "GitHub tracker page is malformed"),
      )
    return Effect.succeed(label.name)
  })
}

const githubBody = (
  value: unknown,
): Effect.Effect<string | undefined, BacklogCollectorError> => {
  if (value === null) return Effect.succeed(undefined)
  return typeof value === "string" &&
    value.length <= 124_000 &&
    !UNSAFE_GITHUB_TEXT_CONTROL.test(value) &&
    !HIGH_CONFIDENCE_SECRET.test(value)
    ? Effect.succeed(value)
    : Effect.fail(failure("source_failure", "GitHub tracker page is malformed"))
}

interface GitHubCommonItem {
  readonly number: number
  readonly title: string
  readonly body?: string
  readonly state: "open" | "closed"
  readonly labels: readonly string[]
  readonly updatedAt: string
}

const githubCommonItem = (
  value: Readonly<Record<string, unknown>>,
): Effect.Effect<GitHubCommonItem, BacklogCollectorError> =>
  Effect.gen(function* () {
    if (
      typeof value.number !== "number" ||
      !Number.isSafeInteger(value.number) ||
      value.number < 1 ||
      value.number > 1_000_000_000 ||
      typeof value.title !== "string" ||
      value.title.length === 0 ||
      value.title.length > 4_000 ||
      UNSAFE_GITHUB_TEXT_CONTROL.test(value.title) ||
      HIGH_CONFIDENCE_SECRET.test(value.title) ||
      (value.state !== "open" && value.state !== "closed") ||
      typeof value.updated_at !== "string" ||
      value.updated_at.length === 0 ||
      value.updated_at.length > 80 ||
      UNSAFE_GITHUB_TEXT_CONTROL.test(value.updated_at)
    )
      return yield* Effect.fail(
        failure("source_failure", "GitHub tracker page is malformed"),
      )
    const body = yield* githubBody(value.body)
    const labels = yield* githubLabels(value.labels)
    return {
      number: value.number,
      title: value.title,
      ...(body === undefined ? {} : { body }),
      state: value.state,
      labels,
      updatedAt: value.updated_at,
    }
  })

// GitHub REST contracts pinned here:
// https://docs.github.com/en/rest/issues/issues#list-repository-issues
// (pull requests also appear in this response and carry `pull_request`).
// https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
// Both lists support stable created-order pagination; issue state reasons are
// `completed`, `not_planned`, or `reopened`, and merged pulls expose `merged_at`.
const githubIssueItem = (
  value: unknown,
): Effect.Effect<GitHubTrackerItemInput | undefined, BacklogCollectorError> =>
  Effect.gen(function* () {
    if (!isRecord(value))
      return yield* Effect.fail(
        failure("source_failure", "GitHub tracker page is malformed"),
      )
    if (value.pull_request !== undefined) {
      return isRecord(value.pull_request)
        ? undefined
        : yield* Effect.fail(
            failure("source_failure", "GitHub tracker page is malformed"),
          )
    }
    if (
      value.state_reason !== null &&
      value.state_reason !== "completed" &&
      value.state_reason !== "not_planned" &&
      value.state_reason !== "reopened"
    )
      return yield* Effect.fail(
        failure("source_failure", "GitHub tracker page is malformed"),
      )
    const common = yield* githubCommonItem(value)
    if (
      (common.state === "open" &&
        value.state_reason !== null &&
        value.state_reason !== "reopened") ||
      (common.state === "closed" && value.state_reason === "reopened")
    )
      return yield* Effect.fail(
        failure("source_failure", "GitHub tracker page is malformed"),
      )
    return {
      kind: "issue",
      ...common,
      ...(common.state === "closed"
        ? {
            stateReason:
              value.state_reason === "not_planned"
                ? "not-planned"
                : "completed",
          }
        : {}),
    }
  })

const githubPullItem = (
  value: unknown,
): Effect.Effect<GitHubTrackerItemInput, BacklogCollectorError> =>
  Effect.gen(function* () {
    if (
      !isRecord(value) ||
      (value.merged_at !== null && typeof value.merged_at !== "string")
    )
      return yield* Effect.fail(
        failure("source_failure", "GitHub tracker page is malformed"),
      )
    const common = yield* githubCommonItem(value)
    return {
      kind: "pull-request",
      ...common,
      state: typeof value.merged_at === "string" ? "merged" : common.state,
    }
  })

const githubPage = (
  content: string,
): Effect.Effect<readonly unknown[], BacklogCollectorError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: (): unknown => JSON.parse(content),
      catch: () =>
        failure("source_failure", "GitHub tracker page is malformed"),
    })
    return Array.isArray(decoded) && decoded.length <= MAX_GITHUB_PAGE_ITEMS
      ? decoded
      : yield* Effect.fail(
          failure("source_failure", "GitHub tracker page is malformed"),
        )
  })

const collectGitHubPages = (
  input: CollectDeclaredGitHubBacklogInput,
  repository: string,
  kind: "github-issues" | "github-pulls",
): Effect.Effect<readonly GitHubTrackerItemInput[], BacklogCollectorError> =>
  Effect.gen(function* () {
    const items: GitHubTrackerItemInput[] = []
    let totalBytes = 0
    for (let page = 1; page <= MAX_GITHUB_PAGES; page += 1) {
      const endpoint = kind === "github-issues" ? "issues" : "pulls"
      const content = yield* input.runCommand({
        kind,
        command: "gh",
        args: [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "GET",
          `repos/${repository}/${endpoint}?state=all&per_page=${MAX_GITHUB_PAGE_ITEMS}&page=${page}&sort=created&direction=asc`,
        ],
        cwd: input.project,
        maxOutputBytes: MAX_GITHUB_PAGE_BYTES,
        timeoutMs: BACKLOG_COMMAND_TIMEOUT_MS,
        page,
      })
      totalBytes += Buffer.byteLength(content, "utf8")
      if (totalBytes > MAX_GITHUB_TOTAL_BYTES)
        return yield* Effect.fail(
          failure("source_failure", "GitHub tracker output is too large"),
        )
      const values = yield* githubPage(content)
      for (const value of values) {
        const item = yield* kind === "github-issues"
          ? githubIssueItem(value)
          : githubPullItem(value)
        if (item) items.push(item)
        if (items.length > MAX_GITHUB_ITEMS)
          return yield* Effect.fail(
            failure("source_failure", "GitHub tracker has too many items"),
          )
      }
      if (values.length < MAX_GITHUB_PAGE_ITEMS) return items
    }
    return yield* Effect.fail(
      failure("source_failure", "GitHub tracker pagination exceeded its cap"),
    )
  })

export const collectDeclaredGitHubBacklog = (
  input: CollectDeclaredGitHubBacklogInput,
): Effect.Effect<CanonicalBacklogSnapshot, BacklogCollectorError> =>
  Effect.gen(function* () {
    const origin = yield* input.runCommand({
      kind: "git-origin",
      command: "git",
      args: ["config", "--local", "--get", "remote.origin.url"],
      cwd: input.project,
      maxOutputBytes: 1_024,
      timeoutMs: BACKLOG_COMMAND_TIMEOUT_MS,
    })
    const repository = yield* canonicalGitHubRepository(origin)
    if (
      input.declared.repository !== undefined &&
      input.declared.repository !== repository
    )
      return yield* Effect.fail(
        failure(
          "invalid_manifest",
          "declared GitHub repository does not match the canonical origin",
        ),
      )
    const issues = yield* collectGitHubPages(input, repository, "github-issues")
    const pulls = yield* collectGitHubPages(input, repository, "github-pulls")
    const items = [...issues, ...pulls]
    if (items.length > MAX_GITHUB_ITEMS)
      return yield* Effect.fail(
        failure("source_failure", "GitHub tracker has too many items"),
      )
    return yield* githubTrackerSnapshot({
      project: canonicalProject(input.project),
      repository,
      observedAt: input.observedAt,
      coverage: "complete",
      items,
    }).pipe(Effect.mapError(error => failure("source_failure", error.message)))
  })

const backlogFileError = (
  cause: unknown,
  signal?: AbortSignal,
): BacklogCollectorError => {
  if (
    signal?.aborted ||
    (cause instanceof DOMException && cause.name === "AbortError") ||
    errorCode(cause) === "ABORT_ERR"
  )
    return failure("cancelled", "declared backlog collection was cancelled")
  return errorCode(cause) === "ENOENT"
    ? failure("missing_document", "declared backlog file is missing")
    : failure("source_failure", "declared backlog file read failed")
}

const fileOperation = <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Effect.Effect<T, BacklogCollectorError> =>
  Effect.tryPromise({
    try: operation,
    catch: cause => backlogFileError(cause, signal),
  })

export const makeDeclaredBacklogFileReader =
  (project: string, signal?: AbortSignal): DeclaredBacklogFileReader =>
  (relativePath, maxBytes) =>
    Effect.gen(function* () {
      if (signal?.aborted)
        return yield* Effect.fail(
          failure("cancelled", "declared backlog collection was cancelled"),
        )
      if (!validDocumentPath(relativePath))
        return yield* Effect.fail(
          failure(
            "invalid_document_path",
            "declared backlog file path is invalid",
          ),
        )
      const root = yield* fileOperation(() => realpath(project), signal)
      let current = root
      for (const segment of relativePath.split("/")) {
        current = join(current, segment)
        const metadata = yield* fileOperation(() => lstat(current), signal)
        if (metadata.isSymbolicLink())
          return yield* Effect.fail(
            failure(
              "invalid_document_path",
              "declared backlog file path contains a symbolic link",
            ),
          )
      }
      const canonical = yield* fileOperation(
        () => realpath(resolve(root, relativePath)),
        signal,
      )
      if (!isInsideRoot(root, canonical))
        return yield* Effect.fail(
          failure(
            "invalid_document_path",
            "declared backlog file resolves outside the project",
          ),
        )
      return yield* Effect.acquireUseRelease(
        fileOperation(
          () =>
            open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
          signal,
        ),
        handle =>
          Effect.gen(function* () {
            const metadata = yield* fileOperation(() => handle.stat(), signal)
            if (!metadata.isFile() || metadata.size > maxBytes)
              return yield* Effect.fail(
                failure(
                  "source_failure",
                  "declared backlog file is not a bounded regular file",
                ),
              )
            const content = yield* fileOperation(
              () => handle.readFile({ encoding: "utf8", signal }),
              signal,
            )
            return Buffer.byteLength(content, "utf8") <= maxBytes
              ? Option.some(content)
              : yield* Effect.fail(
                  failure(
                    "source_failure",
                    "declared backlog file is too large",
                  ),
                )
          }),
        handle =>
          fileOperation(() => handle.close(), signal).pipe(
            Effect.catchAll(() => Effect.void),
          ),
      )
    }).pipe(
      Effect.catchIf(
        error => error.code === "missing_document",
        () => Effect.succeed(Option.none()),
      ),
    )

const decodeManifest = (
  content: string,
): Effect.Effect<DeclaredBacklogSourcesManifest, BacklogCollectorError> =>
  Effect.gen(function* () {
    if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES)
      return yield* Effect.fail(
        failure("invalid_manifest", "backlog source manifest is too large"),
      )
    const decoded = yield* Effect.try({
      try: (): unknown => JSON.parse(content),
      catch: () =>
        failure(
          "invalid_manifest",
          "backlog source manifest is not valid JSON",
        ),
    })
    if (
      !isRecord(decoded) ||
      !hasOnlyKeys(decoded, new Set(["version", "document", "github"])) ||
      decoded.version !== 1 ||
      (decoded.document === undefined && decoded.github === undefined)
    )
      return yield* Effect.fail(
        failure("invalid_manifest", "backlog source manifest shape is invalid"),
      )
    if (
      decoded.document !== undefined &&
      (typeof decoded.document !== "string" ||
        !validDocumentPath(decoded.document))
    )
      return yield* Effect.fail(
        failure(
          "invalid_document_path",
          "declared backlog document path is invalid",
        ),
      )
    if (decoded.github !== undefined) {
      if (
        !isRecord(decoded.github) ||
        !hasOnlyKeys(decoded.github, new Set(["repository"])) ||
        (decoded.github.repository !== undefined &&
          (typeof decoded.github.repository !== "string" ||
            !GITHUB_REPOSITORY.test(decoded.github.repository)))
      )
        return yield* Effect.fail(
          failure("invalid_manifest", "declared GitHub source is invalid"),
        )
    }
    return {
      version: 1,
      ...(typeof decoded.document === "string"
        ? { document: decoded.document }
        : {}),
      ...(isRecord(decoded.github)
        ? {
            github:
              typeof decoded.github.repository === "string"
                ? { repository: decoded.github.repository }
                : {},
          }
        : {}),
    }
  })

export const collectDeclaredBacklogSources = (
  input: CollectDeclaredBacklogSourcesInput,
): Effect.Effect<DeclaredBacklogCollection, BacklogCollectorError> =>
  Effect.gen(function* () {
    if (!input.trusted) return { snapshots: [] }
    const manifestPath = `${input.configDirName}/backlog-sources.json`
    const manifestContent = yield* input.readFile(
      manifestPath,
      MAX_MANIFEST_BYTES,
    )
    if (Option.isNone(manifestContent)) return { snapshots: [] }
    const manifest = yield* decodeManifest(manifestContent.value)
    const snapshots: CanonicalBacklogSnapshot[] = []
    if (manifest.document) {
      const documentContent = yield* input.readFile(
        manifest.document,
        MAX_DOCUMENT_BYTES,
      )
      if (Option.isNone(documentContent))
        return yield* Effect.fail(
          failure("missing_document", "declared backlog document is missing"),
        )
      const snapshot = yield* backlogDocumentSnapshot({
        project: canonicalProject(input.project),
        documentId: manifest.document,
        observedAt: input.observedAt,
        content: documentContent.value,
      }).pipe(
        Effect.mapError(error => failure("source_failure", error.message)),
      )
      snapshots.push(snapshot)
    }
    if (manifest.github && input.collectGitHub) {
      snapshots.push(yield* input.collectGitHub(manifest.github))
    }
    return {
      snapshots,
      ...(manifest.github && !input.collectGitHub
        ? { github: manifest.github }
        : {}),
    }
  })
