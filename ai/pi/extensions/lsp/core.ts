import { readFile, realpath } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { isAbsolute, relative, resolve } from "node:path"
import { Data, Effect, Either } from "effect"

import type { LanguageClient, LspPoint } from "./client.ts"
import {
  profileForFile,
  selectServer,
  SERVER_PROFILES,
  type ServerProfile,
} from "./servers.ts"
import {
  applyPreparedWorkspaceEdit,
  prepareWorkspaceEdit,
  type PreparedWorkspaceEdit,
  type WorkspaceEditIo,
} from "./workspace-edit.ts"

const MAX_LOCATIONS = 200
const MAX_DIAGNOSTICS = 200
const MAX_ACTIONS = 100
const MAX_PREVIEWS = 16
const MAX_PREVIEW_CACHE_BYTES = 32 * 1024 * 1024
const MAX_MESSAGE_LENGTH = 2_000

export type LspAction =
  | "status"
  | "definition"
  | "references"
  | "diagnostics"
  | "rename_preview"
  | "code_actions"
  | "code_action_preview"
  | "apply"

export interface LspToolInput {
  readonly action: LspAction
  readonly file?: string
  readonly line?: number
  readonly symbol?: string
  readonly occurrence?: number
  readonly newName?: string
  readonly selector?: number
  readonly previewId?: string
}

export type LspCoreErrorCode =
  | "invalid_input"
  | "unsupported_file"
  | "server_unavailable"
  | "symbol_not_found"
  | "malformed_server_response"
  | "empty_workspace_edit"
  | "invalid_workspace_edit"
  | "preview_not_found"
  | "preview_mismatch"
  | "stale_preview"
  | "write_failed"
  | "rollback_failed"
  | "unsupported_code_action"

export class LspCoreError extends Data.TaggedError("LspCoreError")<{
  readonly code: LspCoreErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LspLocationDetails {
  readonly path: string
  readonly line: number
  readonly character: number
  readonly endLine: number
  readonly endCharacter: number
}

export interface LspDiagnosticDetails {
  readonly path: string
  readonly line: number
  readonly character: number
  readonly severity?: 1 | 2 | 3 | 4
  readonly source?: string
  readonly message: string
}

export interface LspActionDetails {
  readonly index: number
  readonly title: string
  readonly kind?: string
  readonly applicable: boolean
  readonly disabledReason?: string
}

export interface LspPreviewDetails {
  readonly id: string
  readonly kind: "rename" | "code_action"
  readonly files: readonly {
    readonly path: string
    readonly edits: number
    readonly before: string
    readonly after: string
  }[]
  readonly editCount: number
}

export interface LspResultDetails {
  readonly action: LspAction
  readonly server?: string
  readonly rejection?: {
    readonly code: "server_rejected" | "no_edits"
    readonly message: string
    readonly serverCode?: number
  }
  readonly locations?: readonly LspLocationDetails[]
  readonly diagnostics?: readonly LspDiagnosticDetails[]
  readonly actions?: readonly LspActionDetails[]
  readonly preview?: LspPreviewDetails
  readonly applied?: {
    readonly previewId: string
    readonly files: readonly string[]
  }
  readonly status?: readonly {
    readonly profile: string
    readonly command: string
    readonly activeRoots: readonly string[]
  }[]
  readonly omitted?: number
}

export interface LspCoreResult {
  readonly text: string
  readonly details: LspResultDetails
}

export interface LanguageClientProvider {
  get(
    profile: ServerProfile,
    root: string,
  ): Effect.Effect<LanguageClient, unknown>
  status(): readonly { readonly profile: string; readonly root: string }[]
}

interface LspCoreOptions {
  readonly clients: LanguageClientProvider
  readonly workspaceEditIo?: Partial<WorkspaceEditIo>
}

interface DecodedCodeAction {
  readonly index: number
  readonly title: string
  readonly kind?: string
  readonly edit?: unknown
  readonly hasCommand: boolean
  readonly disabledReason?: string
}

const coreError = (
  code: LspCoreErrorCode,
  message: string,
  cause?: unknown,
): LspCoreError =>
  new LspCoreError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isContainedByOrEqual = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

const pointInput = (
  file: string,
  input: LspToolInput,
): Effect.Effect<LspPoint, LspCoreError> =>
  Effect.gen(function* () {
    const line = input.line
    const symbol = input.symbol
    if (
      typeof line !== "number" ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      typeof symbol !== "string" ||
      symbol.length === 0 ||
      symbol.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(symbol)
    )
      return yield* Effect.fail(
        coreError(
          "invalid_input",
          "Position actions require a positive one-based line and bounded symbol",
        ),
      )
    const occurrence = input.occurrence ?? 1
    if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 100)
      return yield* Effect.fail(
        coreError(
          "invalid_input",
          "Symbol occurrence must be an integer from 1 to 100",
        ),
      )
    const text = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: mapUnknownError,
    })
    const lineText = text.split("\n")[line - 1]
    if (lineText === undefined)
      return yield* Effect.fail(
        coreError("invalid_input", "Requested line is outside the file"),
      )
    let from = 0
    let found = -1
    for (let index = 0; index < occurrence; index += 1) {
      found = lineText.indexOf(symbol, from)
      if (found < 0)
        return yield* Effect.fail(
          coreError(
            "symbol_not_found",
            `Could not find occurrence ${occurrence} of ${symbol} on line ${line}`,
          ),
        )
      from = found + symbol.length
    }
    return { line: line - 1, character: found }
  })

const decodedPosition = (
  value: unknown,
): Effect.Effect<LspPoint, LspCoreError> => {
  if (!isRecord(value))
    return Effect.fail(
      coreError(
        "malformed_server_response",
        "Language server returned a malformed position",
      ),
    )
  return typeof value.line !== "number" ||
    !Number.isSafeInteger(value.line) ||
    value.line < 0 ||
    typeof value.character !== "number" ||
    !Number.isSafeInteger(value.character) ||
    value.character < 0
    ? Effect.fail(
        coreError(
          "malformed_server_response",
          "Language server returned an invalid position",
        ),
      )
    : Effect.succeed({ line: value.line, character: value.character })
}

const decodedRange = (
  value: unknown,
): Effect.Effect<
  { readonly start: LspPoint; readonly end: LspPoint },
  LspCoreError
> =>
  Effect.gen(function* () {
    if (!isRecord(value))
      return yield* Effect.fail(
        coreError(
          "malformed_server_response",
          "Language server returned a malformed range",
        ),
      )
    return {
      start: yield* decodedPosition(value.start),
      end: yield* decodedPosition(value.end),
    }
  })

const locationCandidate = (
  value: unknown,
): Effect.Effect<
  { readonly uri: string; readonly range: unknown },
  LspCoreError
> => {
  if (!isRecord(value))
    return Effect.fail(
      coreError(
        "malformed_server_response",
        "Language server returned a malformed location",
      ),
    )
  if (typeof value.uri === "string")
    return Effect.succeed({ uri: value.uri, range: value.range })
  if (typeof value.targetUri === "string")
    return Effect.succeed({
      uri: value.targetUri,
      range: value.targetSelectionRange ?? value.targetRange,
    })
  return Effect.fail(
    coreError(
      "malformed_server_response",
      "Language server location is missing a file URI",
    ),
  )
}

const decodeLocations = (
  value: unknown,
  cwd: string,
): Effect.Effect<
  {
    readonly locations: LspLocationDetails[]
    readonly omitted: number
  },
  LspCoreError
> =>
  Effect.gen(function* () {
    if (value === null || value === undefined)
      return { locations: [], omitted: 0 }
    const raw = Array.isArray(value) ? value : [value]
    const canonicalRoot = yield* Effect.tryPromise({
      try: () => realpath(resolve(cwd)),
      catch: mapUnknownError,
    })
    const locations: LspLocationDetails[] = []
    let omitted = Math.max(0, raw.length - MAX_LOCATIONS)
    for (const item of raw.slice(0, MAX_LOCATIONS)) {
      const candidate = yield* locationCandidate(item)
      const url = yield* Effect.try({
        try: () => new URL(candidate.uri),
        catch: cause =>
          coreError(
            "malformed_server_response",
            "Language server returned an invalid location URI",
            cause,
          ),
      })
      if (url.protocol !== "file:") {
        omitted += 1
        continue
      }
      const resolvedPath = yield* Effect.tryPromise({
        try: () => realpath(fileURLToPath(url)),
        catch: () => undefined,
      }).pipe(Effect.either)
      if (Either.isLeft(resolvedPath)) {
        omitted += 1
        continue
      }
      if (!isContainedByOrEqual(canonicalRoot, resolvedPath.right)) {
        omitted += 1
        continue
      }
      const range = yield* decodedRange(candidate.range)
      locations.push({
        path: relative(canonicalRoot, resolvedPath.right),
        line: range.start.line + 1,
        character: range.start.character + 1,
        endLine: range.end.line + 1,
        endCharacter: range.end.character + 1,
      })
    }
    return { locations, omitted }
  })

const decodeDiagnostics = (
  value: unknown,
  path: string,
): Effect.Effect<
  {
    readonly diagnostics: LspDiagnosticDetails[]
    readonly omitted: number
  },
  LspCoreError
> =>
  Effect.gen(function* () {
    if (value === undefined)
      return yield* Effect.fail(
        coreError(
          "malformed_server_response",
          "Language server did not publish diagnostics before the timeout",
        ),
      )
    if (!Array.isArray(value))
      return yield* Effect.fail(
        coreError(
          "malformed_server_response",
          "Language server diagnostics must be an array",
        ),
      )
    const diagnostics: LspDiagnosticDetails[] = []
    for (const candidate of value.slice(0, MAX_DIAGNOSTICS)) {
      if (!isRecord(candidate) || typeof candidate.message !== "string")
        return yield* Effect.fail(
          coreError(
            "malformed_server_response",
            "Language server returned a malformed diagnostic",
          ),
        )
      const range = yield* decodedRange(candidate.range)
      const severity = candidate.severity
      const validSeverity: 1 | 2 | 3 | 4 | undefined =
        severity === 1
          ? 1
          : severity === 2
            ? 2
            : severity === 3
              ? 3
              : severity === 4
                ? 4
                : undefined
      if (severity !== undefined && validSeverity === undefined)
        return yield* Effect.fail(
          coreError(
            "malformed_server_response",
            "Language server diagnostic severity is invalid",
          ),
        )
      diagnostics.push({
        path,
        line: range.start.line + 1,
        character: range.start.character + 1,
        ...(validSeverity === undefined ? {} : { severity: validSeverity }),
        ...(typeof candidate.source === "string"
          ? { source: candidate.source.slice(0, 100) }
          : {}),
        message: candidate.message.slice(0, MAX_MESSAGE_LENGTH),
      })
    }
    return {
      diagnostics,
      omitted: Math.max(0, value.length - MAX_DIAGNOSTICS),
    }
  })

const decodeCodeActions = (
  value: unknown,
): Effect.Effect<readonly DecodedCodeAction[], LspCoreError> =>
  Effect.gen(function* () {
    if (value === null || value === undefined) return []
    if (!Array.isArray(value))
      return yield* Effect.fail(
        coreError(
          "malformed_server_response",
          "Language server code actions must be an array",
        ),
      )
    const actions: DecodedCodeAction[] = []
    for (const [index, candidate] of value.slice(0, MAX_ACTIONS).entries()) {
      if (!isRecord(candidate) || typeof candidate.title !== "string")
        return yield* Effect.fail(
          coreError(
            "malformed_server_response",
            "Language server returned a malformed code action",
          ),
        )
      const disabledReason = isRecord(candidate.disabled)
        ? candidate.disabled.reason
        : undefined
      if (disabledReason !== undefined && typeof disabledReason !== "string")
        return yield* Effect.fail(
          coreError(
            "malformed_server_response",
            "Language server code action disabled reason is invalid",
          ),
        )
      actions.push({
        index,
        title: candidate.title.slice(0, 500),
        ...(typeof candidate.kind === "string"
          ? { kind: candidate.kind.slice(0, 100) }
          : {}),
        ...(candidate.edit === undefined ? {} : { edit: candidate.edit }),
        hasCommand: candidate.command !== undefined,
        ...(disabledReason === undefined
          ? {}
          : { disabledReason: disabledReason.slice(0, 500) }),
      })
    }
    return actions
  })

const previewDetails = (
  prepared: PreparedWorkspaceEdit,
  kind: "rename" | "code_action",
): LspPreviewDetails => ({
  id: prepared.previewId,
  kind,
  files: prepared.files.map(file => ({
    path: file.relativePath,
    edits: file.editCount,
    before: file.originalDigest,
    after: file.nextDigest,
  })),
  editCount: prepared.editCount,
})

const mapUnknownError = (cause: unknown): LspCoreError => {
  if (cause instanceof LspCoreError) return cause
  if (isRecord(cause) && typeof cause.code === "string") {
    if (
      cause.code === "unsupported_file" ||
      cause.code === "outside_workspace" ||
      cause.code === "root_not_found"
    )
      return coreError(
        "unsupported_file",
        String(cause.message ?? cause.code),
        cause,
      )
    if (cause.code === "preview_mismatch")
      return coreError("preview_mismatch", String(cause.message), cause)
    if (cause.code === "stale_preview")
      return coreError("stale_preview", String(cause.message), cause)
    if (cause.code === "write_failed")
      return coreError("write_failed", String(cause.message), cause)
    if (cause.code === "rollback_failed")
      return coreError("rollback_failed", String(cause.message), cause)
    if (
      [
        "malformed_workspace_edit",
        "unsupported_resource_operation",
        "unsupported_document_version",
        "unsupported_document_ordering",
        "unsupported_snippet",
        "not_regular_file",
        "too_many_files",
        "too_many_edits",
        "replacement_too_large",
        "source_too_large",
        "result_too_large",
        "preview_too_large",
        "invalid_range",
        "overlapping_edits",
      ].includes(cause.code)
    )
      return coreError("invalid_workspace_edit", String(cause.message), cause)
  }
  return coreError(
    "server_unavailable",
    cause instanceof Error ? cause.message : "Language server is unavailable",
    cause,
  )
}

const boundedExternalMessage = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback
  const message = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
  return message.length > 0 ? message : fallback
}

const locationText = (
  label: string,
  locations: readonly LspLocationDetails[],
  omitted: number,
): string => {
  if (locations.length === 0)
    return omitted > 0
      ? `No in-workspace ${label} found (${omitted} external or invalid location(s) omitted)`
      : `No ${label} found`
  const lines = locations.map(
    item => `${item.path}:${item.line}:${item.character}`,
  )
  if (omitted > 0)
    lines.push(`… ${omitted} external or excess location(s) omitted`)
  return lines.join("\n")
}

export const createLspCore = (options: LspCoreOptions) => {
  const previews = new Map<
    string,
    { readonly prepared: PreparedWorkspaceEdit; readonly bytes: number }
  >()
  let previewCacheBytes = 0

  const forgetPreview = (previewId: string): void => {
    const existing = previews.get(previewId)
    if (!existing) return
    previewCacheBytes -= existing.bytes
    previews.delete(previewId)
  }

  const rememberPreview = (prepared: PreparedWorkspaceEdit): void => {
    const bytes = prepared.files.reduce(
      (total, file) =>
        total +
        Buffer.byteLength(file.originalText, "utf8") +
        Buffer.byteLength(file.nextText, "utf8"),
      0,
    )
    forgetPreview(prepared.previewId)
    previews.set(prepared.previewId, { prepared, bytes })
    previewCacheBytes += bytes
    while (
      previews.size > MAX_PREVIEWS ||
      previewCacheBytes > MAX_PREVIEW_CACHE_BYTES
    ) {
      const oldest = previews.keys().next().value
      if (typeof oldest !== "string") break
      forgetPreview(oldest)
    }
  }

  const execute = (
    input: LspToolInput,
    cwd: string,
    signal?: AbortSignal,
  ): Effect.Effect<LspCoreResult, LspCoreError> =>
    Effect.gen(function* () {
      signal?.throwIfAborted()
      if (input.action === "status") {
        const active = options.clients.status()
        const status = SERVER_PROFILES.map(profile => ({
          profile: profile.id,
          command: profile.command,
          activeRoots: active
            .filter(item => item.profile === profile.id)
            .map(item => item.root),
        }))
        return {
          text: status
            .map(
              item =>
                `${item.profile}: ${item.command}${item.activeRoots.length > 0 ? ` · active ${item.activeRoots.join(", ")}` : " · lazy"}`,
            )
            .join("\n"),
          details: { action: input.action, status },
        }
      }

      if (input.action === "apply") {
        if (typeof input.previewId !== "string")
          return yield* Effect.fail(
            coreError("invalid_input", "Apply requires previewId"),
          )
        const cachedPreview = previews.get(input.previewId)
        const prepared = cachedPreview?.prepared
        if (
          !prepared ||
          prepared.cwd !==
            (yield* Effect.tryPromise({
              try: () => realpath(resolve(cwd)),
              catch: mapUnknownError,
            }))
        )
          return yield* Effect.fail(
            coreError(
              "preview_not_found",
              "LSP preview is unknown or belongs to another workspace; preview again",
            ),
          )
        const applied = yield* applyPreparedWorkspaceEdit(
          prepared,
          input.previewId,
          options.workspaceEditIo,
          signal,
        ).pipe(Effect.mapError(mapUnknownError))
        forgetPreview(input.previewId)
        return {
          text: `Applied ${applied.files.length} file(s) from ${applied.previewId}`,
          details: { action: input.action, applied },
        }
      }

      if (typeof input.file !== "string" || input.file.length === 0)
        return yield* Effect.fail(
          coreError("invalid_input", `${input.action} requires file`),
        )
      const selection = yield* selectServer({ cwd, file: input.file }).pipe(
        Effect.mapError(mapUnknownError),
      )
      const client = yield* options.clients
        .get(selection.profile, selection.root)
        .pipe(Effect.mapError(mapUnknownError))
      const server = selection.profile.command
      const relativeFile = relative(selection.root, selection.file)

      if (input.action === "diagnostics") {
        const raw = yield* client
          .diagnostics(selection.file)
          .pipe(Effect.mapError(mapUnknownError))
        const decoded = yield* decodeDiagnostics(raw, relativeFile)
        const text =
          decoded.diagnostics.length === 0
            ? "OK · no diagnostics"
            : decoded.diagnostics
                .map(
                  item =>
                    `${item.path}:${item.line}:${item.character} ${item.source ? `[${item.source}] ` : ""}${item.message}`,
                )
                .join("\n")
        return {
          text:
            decoded.omitted > 0
              ? `${text}\n… ${decoded.omitted} diagnostic(s) omitted`
              : text,
          details: {
            action: input.action,
            server,
            diagnostics: decoded.diagnostics,
            omitted: decoded.omitted,
          },
        }
      }

      const point = yield* pointInput(selection.file, input)

      if (input.action === "definition" || input.action === "references") {
        const raw = yield* client[input.action](selection.file, point).pipe(
          Effect.mapError(mapUnknownError),
        )
        const decoded = yield* decodeLocations(raw, selection.root)
        return {
          text: locationText(input.action, decoded.locations, decoded.omitted),
          details: {
            action: input.action,
            server,
            locations: decoded.locations,
            omitted: decoded.omitted,
          },
        }
      }

      if (input.action === "rename_preview") {
        if (
          typeof input.newName !== "string" ||
          input.newName.length === 0 ||
          input.newName.length > 256 ||
          /[\u0000-\u001f\u007f]/u.test(input.newName)
        )
          return yield* Effect.fail(
            coreError(
              "invalid_input",
              "Rename requires a bounded non-empty newName",
            ),
          )
        const renameAttempt = yield* client
          .rename(selection.file, point, input.newName)
          .pipe(Effect.either)
        if (Either.isLeft(renameAttempt)) {
          const failure = renameAttempt.left
          if (failure.code !== "request_rejected")
            return yield* Effect.fail(mapUnknownError(failure))
          const message = boundedExternalMessage(
            failure.serverDiagnostic ?? failure.message,
            "Language server rejected the rename request",
          )
          return {
            text: `Rename preview unavailable · ${message}`,
            details: {
              action: input.action,
              server,
              rejection: {
                code: "server_rejected",
                message,
                ...(failure.serverCode === undefined
                  ? {}
                  : { serverCode: failure.serverCode }),
              },
            },
          }
        }
        const edit = renameAttempt.right
        if (edit === null || edit === undefined) {
          const message = "Language server returned no rename edits"
          return {
            text: `Rename preview unavailable · ${message}`,
            details: {
              action: input.action,
              server,
              rejection: { code: "no_edits", message },
            },
          }
        }
        const prepared = yield* prepareWorkspaceEdit({
          cwd: selection.root,
          edit,
          ...(options.workspaceEditIo ? { io: options.workspaceEditIo } : {}),
        }).pipe(Effect.mapError(mapUnknownError))
        rememberPreview(prepared)
        const preview = previewDetails(prepared, "rename")
        return {
          text: `Rename preview ${preview.id}\n${preview.editCount} edit(s) across ${preview.files.length} file(s)\n${preview.files.map(file => `- ${file.path} · ${file.edits} edit(s)`).join("\n")}`,
          details: { action: input.action, server, preview },
        }
      }

      const rawActions = yield* client
        .codeActions(selection.file, point)
        .pipe(Effect.mapError(mapUnknownError))
      const actions = yield* decodeCodeActions(rawActions)
      if (input.action === "code_actions") {
        const details = actions.map(action => ({
          index: action.index,
          title: action.title,
          ...(action.kind ? { kind: action.kind } : {}),
          applicable:
            action.edit !== undefined &&
            !action.hasCommand &&
            action.disabledReason === undefined,
          ...(action.disabledReason
            ? { disabledReason: action.disabledReason }
            : {}),
        }))
        return {
          text:
            details.length === 0
              ? "No code actions"
              : details
                  .map(
                    action =>
                      `${action.index}: ${action.kind ? `[${action.kind}] ` : ""}${action.title}${action.applicable ? "" : " · preview unavailable"}`,
                  )
                  .join("\n"),
          details: {
            action: input.action,
            server,
            actions: details,
            omitted: Array.isArray(rawActions)
              ? Math.max(0, rawActions.length - MAX_ACTIONS)
              : 0,
          },
        }
      }

      const selector = input.selector
      if (
        typeof selector !== "number" ||
        !Number.isSafeInteger(selector) ||
        selector < 0
      )
        return yield* Effect.fail(
          coreError(
            "invalid_input",
            "Code action preview requires a non-negative selector",
          ),
        )
      const selected = actions[selector]
      if (!selected)
        return yield* Effect.fail(
          coreError("invalid_input", "Code action selector is out of range"),
        )
      if (
        selected.edit === undefined ||
        selected.hasCommand ||
        selected.disabledReason !== undefined
      )
        return yield* Effect.fail(
          coreError(
            "unsupported_code_action",
            "Only enabled edit-only code actions can be previewed; commands are never executed",
          ),
        )
      const prepared = yield* prepareWorkspaceEdit({
        cwd: selection.root,
        edit: selected.edit,
        ...(options.workspaceEditIo ? { io: options.workspaceEditIo } : {}),
      }).pipe(Effect.mapError(mapUnknownError))
      rememberPreview(prepared)
      const preview = previewDetails(prepared, "code_action")
      return {
        text: `Code action preview ${preview.id}\n${selected.title}\n${preview.editCount} edit(s) across ${preview.files.length} file(s)`,
        details: { action: input.action, server, preview },
      }
    })

  return {
    execute: (input: LspToolInput, cwd: string, signal?: AbortSignal) =>
      execute(input, cwd, signal).pipe(Effect.mapError(mapUnknownError)),
    clearPreviews: () => {
      previews.clear()
      previewCacheBytes = 0
    },
    profileForFile,
  }
}
