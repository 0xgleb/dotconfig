import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Cause, Data, Effect, Option, Runtime } from "effect"
import { isAbsolute, relative, resolve } from "node:path"

const MAX_FILES = 32
const MAX_EDITS = 1_000
const MAX_REPLACEMENT_BYTES = 1024 * 1024
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_RESULT_BYTES = 8 * 1024 * 1024
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024
const PREVIEW_PREFIX = "lsp-preview-v1:"

export type WorkspaceEditErrorCode =
  | "malformed_workspace_edit"
  | "unsupported_resource_operation"
  | "unsupported_document_version"
  | "unsupported_document_ordering"
  | "unsupported_snippet"
  | "outside_workspace"
  | "not_regular_file"
  | "too_many_files"
  | "too_many_edits"
  | "replacement_too_large"
  | "source_too_large"
  | "result_too_large"
  | "preview_too_large"
  | "invalid_range"
  | "overlapping_edits"
  | "preview_mismatch"
  | "stale_preview"
  | "write_failed"
  | "rollback_failed"

export class WorkspaceEditError extends Data.TaggedError("WorkspaceEditError")<{
  readonly code: WorkspaceEditErrorCode
  readonly message: string
  readonly cause?: unknown
}> {}

interface Position {
  readonly line: number
  readonly character: number
}

interface Range {
  readonly start: Position
  readonly end: Position
}

interface DecodedTextEdit {
  readonly range: Range
  readonly newText: string
  readonly index: number
}

export interface PreparedFileEdit {
  readonly path: string
  readonly relativePath: string
  readonly originalText: string
  readonly nextText: string
  readonly originalDigest: string
  readonly nextDigest: string
  readonly device: number
  readonly inode: number
  readonly mode: number
  readonly editCount: number
}

export interface PreparedWorkspaceEdit {
  readonly previewId: string
  readonly cwd: string
  readonly files: readonly PreparedFileEdit[]
  readonly editCount: number
}

export interface FileIdentity {
  readonly device: number
  readonly inode: number
  readonly mode: number
}

export interface WorkspaceEditIo {
  readonly readText: (
    path: string,
    expected?: FileIdentity,
    maxBytes?: number,
  ) => Promise<string>
  readonly writeText: (
    path: string,
    text: string,
    expected?: FileIdentity,
  ) => Promise<void>
  readonly withMutationQueue: <T>(
    path: string,
    work: () => Promise<T>,
  ) => Promise<T>
  readonly realpath?: (path: string) => Promise<string>
  readonly fileIdentity?: (path: string) => Promise<FileIdentity>
}

const identityFromStat = (stat: {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  isFile(): boolean
}): Effect.Effect<FileIdentity, WorkspaceEditError> =>
  stat.isFile()
    ? Effect.succeed({
        device: stat.dev,
        inode: stat.ino,
        mode: stat.mode & 0o777,
      })
    : Effect.fail(
        error("not_regular_file", "LSP edit target is not a regular file"),
      )

const fileIdentity = async (path: string): Promise<FileIdentity> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stat = yield* Effect.tryPromise({
        try: () => lstat(path),
        catch: asWorkspaceEditError,
      })
      if (stat.isSymbolicLink())
        return yield* Effect.fail(
          error("not_regular_file", "LSP edit target is not a regular file"),
        )
      return yield* identityFromStat(stat)
    }),
  )

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device && left.inode === right.inode

export const readBoundedRegularText = async (
  path: string,
  maxBytes: number,
  expected?: FileIdentity,
): Promise<{ readonly text: string; readonly identity: FileIdentity }> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
        catch: asWorkspaceEditError,
      }),
      handle =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: asWorkspaceEditError,
          })
          const identity = yield* identityFromStat(stat)
          if (expected && !sameIdentity(identity, expected))
            return yield* Effect.fail(
              error("stale_preview", "LSP read target identity changed"),
            )
          if (stat.size > maxBytes)
            return yield* Effect.fail(
              error("source_too_large", `LSP source exceeds ${maxBytes} bytes`),
            )
          const text = yield* Effect.tryPromise({
            try: () => handle.readFile("utf8"),
            catch: asWorkspaceEditError,
          })
          const current = yield* Effect.tryPromise({
            try: () => fileIdentity(path),
            catch: asWorkspaceEditError,
          })
          if (!sameIdentity(identity, current))
            return yield* Effect.fail(
              error("stale_preview", "LSP read target changed during read"),
            )
          return { text, identity }
        }),
      handle =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: asWorkspaceEditError,
        }).pipe(Effect.ignore),
    ),
  )

const writeNoFollowText = async (
  path: string,
  text: string,
  expected?: FileIdentity,
): Promise<void> =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_WRONLY | constants.O_NOFOLLOW),
        catch: asWorkspaceEditError,
      }),
      handle =>
        Effect.gen(function* () {
          const identity = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: asWorkspaceEditError,
          }).pipe(Effect.flatMap(identityFromStat))
          if (expected && !sameIdentity(identity, expected))
            return yield* Effect.fail(
              error("stale_preview", "LSP edit target identity changed"),
            )
          yield* Effect.tryPromise({
            try: () => handle.truncate(0),
            catch: asWorkspaceEditError,
          })
          yield* Effect.tryPromise({
            try: () => handle.writeFile(text, "utf8"),
            catch: asWorkspaceEditError,
          })
          yield* Effect.tryPromise({
            try: () => handle.sync(),
            catch: asWorkspaceEditError,
          })
        }),
      handle =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: asWorkspaceEditError,
        }).pipe(Effect.ignore),
    ),
  )

const defaultIo: WorkspaceEditIo = {
  readText: async (path, expected, maxBytes = MAX_SOURCE_BYTES) =>
    (await readBoundedRegularText(path, maxBytes, expected)).text,
  writeText: writeNoFollowText,
  withMutationQueue: (_path, work) => work(),
  realpath,
  fileIdentity,
}

const error = (
  code: WorkspaceEditErrorCode,
  message: string,
  cause?: unknown,
): WorkspaceEditError =>
  new WorkspaceEditError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const asWorkspaceEditError = (cause: unknown): WorkspaceEditError => {
  if (cause instanceof WorkspaceEditError) return cause
  if (Runtime.isFiberFailure(cause)) {
    const failure = Option.getOrUndefined(
      Cause.failureOption(cause[Runtime.FiberFailureCauseId]),
    )
    if (failure instanceof WorkspaceEditError) return failure
  }
  const detail = cause instanceof Error ? `: ${cause.message}` : ""
  return error(
    "malformed_workspace_edit",
    `Workspace edit processing failed${detail}`.slice(0, 1_000),
    cause,
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const isContainedBy = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child)
}

const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined

const decodePosition = (
  value: unknown,
): Effect.Effect<Position, WorkspaceEditError> => {
  if (!isRecord(value))
    return Effect.fail(
      error("malformed_workspace_edit", "LSP position must be an object"),
    )
  const line = integer(value.line)
  const character = integer(value.character)
  return line === undefined || character === undefined
    ? Effect.fail(
        error(
          "malformed_workspace_edit",
          "LSP position line and character must be non-negative integers",
        ),
      )
    : Effect.succeed({ line, character })
}

const decodeRange = (
  value: unknown,
): Effect.Effect<Range, WorkspaceEditError> =>
  Effect.gen(function* () {
    if (!isRecord(value))
      return yield* Effect.fail(
        error("malformed_workspace_edit", "LSP range must be an object"),
      )
    return {
      start: yield* decodePosition(value.start),
      end: yield* decodePosition(value.end),
    }
  })

const decodeTextEdit = (
  value: unknown,
  index: number,
): Effect.Effect<DecodedTextEdit, WorkspaceEditError> =>
  Effect.gen(function* () {
    if (!isRecord(value) || typeof value.newText !== "string")
      return yield* Effect.fail(
        error(
          "malformed_workspace_edit",
          "LSP text edit must contain range and newText",
        ),
      )
    if (value.insertTextFormat === 2)
      return yield* Effect.fail(
        error(
          "unsupported_snippet",
          "Snippet-formatted LSP edits are not supported",
        ),
      )
    return {
      range: yield* decodeRange(value.range),
      newText: value.newText,
      index,
    }
  })

const decodeWorkspaceTextEdits = (
  value: unknown,
): Effect.Effect<
  ReadonlyMap<string, readonly DecodedTextEdit[]>,
  WorkspaceEditError
> =>
  Effect.gen(function* () {
    if (!isRecord(value))
      return yield* Effect.fail(
        error(
          "malformed_workspace_edit",
          "LSP workspace edit must be an object",
        ),
      )
    const grouped = new Map<string, DecodedTextEdit[]>()
    let editIndex = 0
    const add = (
      uri: unknown,
      edits: unknown,
      rejectExisting = false,
    ): Effect.Effect<void, WorkspaceEditError> =>
      Effect.gen(function* () {
        if (typeof uri !== "string" || !Array.isArray(edits))
          return yield* Effect.fail(
            error(
              "malformed_workspace_edit",
              "LSP workspace text edits must map a URI to an edit array",
            ),
          )
        if (rejectExisting && grouped.has(uri))
          return yield* Effect.fail(
            error(
              "unsupported_document_ordering",
              "Repeated ordered TextDocumentEdit entries for one URI are not supported",
            ),
          )
        const target = grouped.get(uri) ?? []
        for (const candidate of edits) {
          target.push(yield* decodeTextEdit(candidate, editIndex))
          editIndex += 1
          if (editIndex > MAX_EDITS)
            return yield* Effect.fail(
              error("too_many_edits", `LSP edit exceeds ${MAX_EDITS} edits`),
            )
        }
        grouped.set(uri, target)
      })

    if (value.changes !== undefined) {
      if (!isRecord(value.changes))
        return yield* Effect.fail(
          error(
            "malformed_workspace_edit",
            "LSP workspace changes must be an object",
          ),
        )
      for (const [uri, edits] of Object.entries(value.changes))
        yield* add(uri, edits)
    }
    if (value.documentChanges !== undefined) {
      if (!Array.isArray(value.documentChanges))
        return yield* Effect.fail(
          error(
            "malformed_workspace_edit",
            "LSP documentChanges must be an array",
          ),
        )
      for (const change of value.documentChanges) {
        if (!isRecord(change))
          return yield* Effect.fail(
            error(
              "malformed_workspace_edit",
              "LSP document change must be an object",
            ),
          )
        if (typeof change.kind === "string")
          return yield* Effect.fail(
            error(
              "unsupported_resource_operation",
              `LSP resource operation ${change.kind} is not supported`,
            ),
          )
        if (!isRecord(change.textDocument))
          return yield* Effect.fail(
            error(
              "malformed_workspace_edit",
              "LSP text document edit is missing textDocument",
            ),
          )
        if (
          change.textDocument.version !== undefined &&
          change.textDocument.version !== null
        )
          return yield* Effect.fail(
            error(
              "unsupported_document_version",
              "Versioned TextDocumentEdit requires a document-version proof",
            ),
          )
        yield* add(change.textDocument.uri, change.edits, true)
      }
    }
    if (grouped.size === 0)
      return yield* Effect.fail(
        error(
          "malformed_workspace_edit",
          "LSP workspace edit contains no text edits",
        ),
      )
    return grouped.size > MAX_FILES
      ? yield* Effect.fail(
          error("too_many_files", `LSP edit exceeds ${MAX_FILES} files`),
        )
      : grouped
  })

const positionOffset = (
  text: string,
  lineStarts: readonly number[],
  position: Position,
): Effect.Effect<number, WorkspaceEditError> => {
  const start = lineStarts[position.line]
  if (start === undefined)
    return Effect.fail(
      error("invalid_range", "LSP edit line is outside the file"),
    )
  const lineEnd = text.indexOf("\n", start)
  const physicalEnd = lineEnd === -1 ? text.length : lineEnd
  const logicalEnd =
    physicalEnd > start && text[physicalEnd - 1] === "\r"
      ? physicalEnd - 1
      : physicalEnd
  return position.character > logicalEnd - start
    ? Effect.fail(
        error("invalid_range", "LSP edit character is outside the line"),
      )
    : Effect.succeed(start + position.character)
}

const lineStarts = (text: string): readonly number[] => {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1)
  }
  return starts
}

interface OffsetEdit extends DecodedTextEdit {
  readonly startOffset: number
  readonly endOffset: number
}

const normalizeEdits = (
  text: string,
  edits: readonly DecodedTextEdit[],
): Effect.Effect<readonly OffsetEdit[], WorkspaceEditError> =>
  Effect.gen(function* () {
    const starts = lineStarts(text)
    const normalized: OffsetEdit[] = []
    for (const edit of edits) {
      const startOffset = yield* positionOffset(text, starts, edit.range.start)
      const endOffset = yield* positionOffset(text, starts, edit.range.end)
      if (endOffset < startOffset)
        return yield* Effect.fail(
          error("invalid_range", "LSP edit range ends before it starts"),
        )
      normalized.push({ ...edit, startOffset, endOffset })
    }
    const sorted = normalized.toSorted(
      (left, right) =>
        right.startOffset - left.startOffset ||
        right.endOffset - left.endOffset ||
        right.index - left.index,
    )
    const unique: OffsetEdit[] = []
    for (const edit of sorted) {
      const previous = unique.at(-1)
      if (
        previous &&
        edit.startOffset !== edit.endOffset &&
        edit.startOffset === previous.startOffset &&
        edit.endOffset === previous.endOffset &&
        edit.newText === previous.newText
      )
        continue
      unique.push(edit)
    }
    for (let index = 0; index < unique.length - 1; index += 1) {
      const later = unique[index]
      const earlier = unique[index + 1]
      if (later && earlier && earlier.endOffset > later.startOffset)
        return yield* Effect.fail(
          error(
            "overlapping_edits",
            "LSP workspace edit contains overlapping ranges",
          ),
        )
    }
    return unique
  })

const applyOffsetEdits = (text: string, edits: readonly OffsetEdit[]): string =>
  edits.reduce(
    (current, edit) =>
      current.slice(0, edit.startOffset) +
      edit.newText +
      current.slice(edit.endOffset),
    text,
  )

const filePathFromUri = (
  uri: string,
): Effect.Effect<string, WorkspaceEditError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new URL(uri),
      catch: cause =>
        error("malformed_workspace_edit", "LSP edit URI is malformed", cause),
    })
    if (parsed.protocol !== "file:")
      return yield* Effect.fail(
        error("outside_workspace", "LSP edits must target file URIs"),
      )
    return yield* Effect.try({
      try: () => fileURLToPath(parsed),
      catch: cause =>
        error("malformed_workspace_edit", "LSP file URI is malformed", cause),
    })
  })

const resolvedIo = (overrides?: Partial<WorkspaceEditIo>): WorkspaceEditIo => ({
  ...defaultIo,
  ...overrides,
})

export const prepareWorkspaceEdit = (input: {
  readonly cwd: string
  readonly edit: unknown
  readonly io?: Partial<WorkspaceEditIo>
}): Effect.Effect<PreparedWorkspaceEdit, WorkspaceEditError> =>
  Effect.gen(function* () {
    const io = resolvedIo(input.io)
    const canonicalRoot = yield* Effect.tryPromise({
      try: () => (io.realpath ?? realpath)(resolve(input.cwd)),
      catch: asWorkspaceEditError,
    })
    const grouped = yield* decodeWorkspaceTextEdits(input.edit)
    let replacementBytes = 0
    let previewBytes = 0
    const files: PreparedFileEdit[] = []

    for (const [uri, rawEdits] of grouped) {
      const requestedPath = yield* filePathFromUri(uri)
      const canonicalPath = yield* Effect.tryPromise({
        try: () => (io.realpath ?? realpath)(requestedPath),
        catch: asWorkspaceEditError,
      })
      if (!isContainedBy(canonicalRoot, canonicalPath))
        return yield* Effect.fail(
          error(
            "outside_workspace",
            "LSP edit targets a file outside the current workspace",
          ),
        )
      const identity = yield* Effect.tryPromise({
        try: () => (io.fileIdentity ?? fileIdentity)(canonicalPath),
        catch: asWorkspaceEditError,
      })
      const originalText = yield* Effect.tryPromise({
        try: () => io.readText(canonicalPath, identity, MAX_SOURCE_BYTES),
        catch: asWorkspaceEditError,
      })
      const originalBytes = Buffer.byteLength(originalText, "utf8")
      if (originalBytes > MAX_SOURCE_BYTES)
        return yield* Effect.fail(
          error(
            "source_too_large",
            `LSP edit source exceeds ${MAX_SOURCE_BYTES} bytes`,
          ),
        )
      for (const edit of rawEdits) {
        replacementBytes += Buffer.byteLength(edit.newText, "utf8")
        if (replacementBytes > MAX_REPLACEMENT_BYTES)
          return yield* Effect.fail(
            error(
              "replacement_too_large",
              `LSP replacement text exceeds ${MAX_REPLACEMENT_BYTES} bytes`,
            ),
          )
      }
      const edits = yield* normalizeEdits(originalText, rawEdits)
      const nextText = applyOffsetEdits(originalText, edits)
      const resultBytes = Buffer.byteLength(nextText, "utf8")
      if (resultBytes > MAX_RESULT_BYTES)
        return yield* Effect.fail(
          error(
            "result_too_large",
            `LSP edit result exceeds ${MAX_RESULT_BYTES} bytes`,
          ),
        )
      previewBytes += originalBytes + resultBytes
      if (previewBytes > MAX_PREVIEW_BYTES)
        return yield* Effect.fail(
          error(
            "preview_too_large",
            `LSP preview exceeds ${MAX_PREVIEW_BYTES} retained bytes`,
          ),
        )
      files.push({
        path: canonicalPath,
        relativePath: relative(canonicalRoot, canonicalPath),
        originalText,
        nextText,
        originalDigest: sha256(originalText),
        nextDigest: sha256(nextText),
        device: identity.device,
        inode: identity.inode,
        mode: identity.mode,
        editCount: edits.length,
      })
    }

    files.sort((left, right) => left.path.localeCompare(right.path))
    const editCount = files.reduce((total, file) => total + file.editCount, 0)
    const previewDigest = sha256(
      JSON.stringify(
        files.map(file => ({
          path: file.relativePath,
          before: file.originalDigest,
          after: file.nextDigest,
          edits: file.editCount,
        })),
      ),
    )
    return {
      previewId: `${PREVIEW_PREFIX}${previewDigest}`,
      cwd: canonicalRoot,
      files,
      editCount,
    }
  })

const withAllMutationQueues = <T>(
  io: WorkspaceEditIo,
  paths: readonly string[],
  work: () => Effect.Effect<T, WorkspaceEditError>,
  index = 0,
): Effect.Effect<T, WorkspaceEditError> => {
  const path = paths[index]
  if (path === undefined) return work()
  return Effect.tryPromise({
    try: () =>
      io.withMutationQueue(path, () =>
        Effect.runPromise(withAllMutationQueues(io, paths, work, index + 1)),
      ),
    catch: asWorkspaceEditError,
  })
}

const ensureApplyActive = (
  signal: AbortSignal | undefined,
): Effect.Effect<void, WorkspaceEditError> =>
  signal?.aborted
    ? Effect.fail(error("write_failed", "LSP edit application was cancelled"))
    : Effect.void

export const applyPreparedWorkspaceEdit = (
  prepared: PreparedWorkspaceEdit,
  previewId: string,
  overrides?: Partial<WorkspaceEditIo>,
  signal?: AbortSignal,
): Effect.Effect<
  { readonly previewId: string; readonly files: readonly string[] },
  WorkspaceEditError
> =>
  Effect.gen(function* () {
    yield* ensureApplyActive(signal)
    if (previewId !== prepared.previewId)
      return yield* Effect.fail(
        error(
          "preview_mismatch",
          "Apply requires the exact current LSP preview ID",
        ),
      )
    const io = resolvedIo(overrides)
    const paths = prepared.files.map(file => file.path).toSorted()
    return yield* withAllMutationQueues(io, paths, () =>
      Effect.gen(function* () {
        yield* ensureApplyActive(signal)
        for (const file of prepared.files) {
          const currentPath = yield* Effect.tryPromise({
            try: () => (io.realpath ?? realpath)(file.path),
            catch: asWorkspaceEditError,
          })
          if (
            currentPath !== file.path ||
            !isContainedBy(prepared.cwd, currentPath)
          )
            return yield* Effect.fail(
              error(
                "stale_preview",
                `LSP preview target changed: ${file.relativePath}`,
              ),
            )
          const identity = yield* Effect.tryPromise({
            try: () => (io.fileIdentity ?? fileIdentity)(file.path),
            catch: asWorkspaceEditError,
          })
          if (identity.device !== file.device || identity.inode !== file.inode)
            return yield* Effect.fail(
              error(
                "stale_preview",
                `LSP preview target identity changed: ${file.relativePath}`,
              ),
            )
          const current = yield* Effect.tryPromise({
            try: () => io.readText(file.path, identity, MAX_SOURCE_BYTES),
            catch: asWorkspaceEditError,
          })
          if (sha256(current) !== file.originalDigest)
            return yield* Effect.fail(
              error(
                "stale_preview",
                `LSP preview is stale for ${file.relativePath}`,
              ),
            )
        }

        const attempted: PreparedFileEdit[] = []
        let writeFailure: WorkspaceEditError | undefined
        for (const file of prepared.files) {
          const written = yield* Effect.either(
            Effect.gen(function* () {
              yield* ensureApplyActive(signal)
              attempted.push(file)
              yield* Effect.tryPromise({
                try: () =>
                  io.writeText(file.path, file.nextText, {
                    device: file.device,
                    inode: file.inode,
                    mode: file.mode,
                  }),
                catch: asWorkspaceEditError,
              })
              const writtenPath = yield* Effect.tryPromise({
                try: () => (io.realpath ?? realpath)(file.path),
                catch: asWorkspaceEditError,
              })
              const writtenIdentity = yield* Effect.tryPromise({
                try: () => (io.fileIdentity ?? fileIdentity)(file.path),
                catch: asWorkspaceEditError,
              })
              const content = yield* Effect.tryPromise({
                try: () =>
                  io.readText(file.path, writtenIdentity, MAX_RESULT_BYTES),
                catch: asWorkspaceEditError,
              })
              if (
                writtenPath !== file.path ||
                sha256(content) !== file.nextDigest
              )
                return yield* Effect.fail(
                  error(
                    "write_failed",
                    `LSP write verification failed for ${file.relativePath}`,
                  ),
                )
            }),
          )
          if (written._tag === "Left") {
            writeFailure = written.left
            break
          }
        }
        if (writeFailure) {
          const rollbackFailures: unknown[] = []
          for (const file of attempted.toReversed()) {
            const restored = yield* Effect.either(
              Effect.tryPromise({
                try: () => io.writeText(file.path, file.originalText),
                catch: asWorkspaceEditError,
              }),
            )
            if (restored._tag === "Left") rollbackFailures.push(restored.left)
          }
          return rollbackFailures.length > 0
            ? yield* Effect.fail(
                error(
                  "rollback_failed",
                  "LSP edit failed and one or more files could not be restored",
                  { cause: writeFailure, rollbackFailures },
                ),
              )
            : yield* Effect.fail(
                error(
                  "write_failed",
                  "LSP edit failed; the executed prefix was restored",
                  writeFailure,
                ),
              )
        }
        return {
          previewId: prepared.previewId,
          files: prepared.files.map(file => file.relativePath),
        }
      }),
    )
  })
