import { createHash } from "node:crypto"
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process"
import { pathToFileURL } from "node:url"
import { Data, Effect } from "effect"

import { JsonRpcConnection, LspRpcError } from "./json-rpc.ts"
import type { ServerProfile } from "./servers.ts"
import { readBoundedRegularText } from "./workspace-edit.ts"

const DIAGNOSTICS_WAIT_MS = 1_500
const MAX_DIAGNOSTICS = 200
const MAX_OPEN_DOCUMENTS = 64
const MAX_SYNC_BYTES = 4 * 1024 * 1024
const SERVER_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NIX_PATH",
  "IN_NIX_SHELL",
] as const

export class LspClientError extends Data.TaggedError("LspClientError")<{
  readonly code:
    | "spawn_failed"
    | "initialize_failed"
    | "unsupported_capability"
    | "request_rejected"
    | "request_failed"
    | "closed"
  readonly message: string
  readonly cause?: unknown
  readonly serverCode?: number
  readonly serverDiagnostic?: string
}> {}

export interface LspPoint {
  readonly line: number
  readonly character: number
}

export interface LanguageClient {
  readonly profile: ServerProfile
  readonly root: string
  readonly capabilities: Readonly<Record<string, unknown>>
  definition(
    file: string,
    point: LspPoint,
  ): Effect.Effect<unknown, LspClientError>
  references(
    file: string,
    point: LspPoint,
  ): Effect.Effect<unknown, LspClientError>
  diagnostics(file: string): Effect.Effect<unknown, LspClientError>
  rename(
    file: string,
    point: LspPoint,
    newName: string,
  ): Effect.Effect<unknown, LspClientError>
  codeActions(
    file: string,
    point: LspPoint,
  ): Effect.Effect<unknown, LspClientError>
  isClosed(): boolean
  dispose(): Promise<void>
}

export interface LspProcessFactory {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams
}

const defaultProcessFactory: LspProcessFactory = {
  spawn: (command, args, options) =>
    spawn(command, [...args], { ...options, stdio: "pipe" }),
}

const clientError = (
  code: LspClientError["code"],
  message: string,
  cause?: unknown,
  server?: {
    readonly code: number
    readonly diagnostic: string
  },
): LspClientError =>
  new LspClientError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(server === undefined
      ? {}
      : {
          serverCode: server.code,
          serverDiagnostic: server.diagnostic,
        }),
  })

const boundedCauseDiagnostic = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error)) return undefined
  const diagnostic = cause.message
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500)
  return diagnostic.length > 0 ? diagnostic : undefined
}

const STANDARD_REJECTION_CODES = new Set([-32_602, -32_803])

const asClientError = (cause: unknown): LspClientError => {
  if (cause instanceof LspClientError) return cause
  if (cause instanceof LspRpcError) {
    if (
      cause.code === "server_error" &&
      cause.serverCode !== undefined &&
      cause.serverDiagnostic !== undefined &&
      STANDARD_REJECTION_CODES.has(cause.serverCode)
    )
      return clientError("request_rejected", cause.serverDiagnostic, cause, {
        code: cause.serverCode,
        diagnostic: cause.serverDiagnostic,
      })
    return clientError("request_failed", cause.message, cause)
  }
  const diagnostic = boundedCauseDiagnostic(cause)
  return clientError(
    "request_failed",
    diagnostic
      ? `Language server request failed: ${diagnostic}`
      : "Language server request failed",
    cause,
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

export const languageServerEnvironment = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    SERVER_ENV_KEYS.flatMap(key =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  )

const capabilityEnabled = (
  capabilities: Readonly<Record<string, unknown>>,
  name: string,
): boolean => capabilities[name] !== undefined && capabilities[name] !== false

interface OpenDocument {
  readonly version: number
  readonly digest: string
  readonly text: string
}

interface TextDocumentSyncPolicy {
  readonly openClose: boolean
  readonly change: 0 | 1 | 2
}

const textDocumentSyncPolicy = (
  capabilities: Readonly<Record<string, unknown>>,
): TextDocumentSyncPolicy => {
  const sync = capabilities.textDocumentSync
  if (sync === 0 || sync === 1 || sync === 2)
    return { openClose: sync !== 0, change: sync }
  if (!isRecord(sync)) return { openClose: false, change: 0 }
  const change = sync.change
  return {
    openClose: sync.openClose === true,
    change: change === 1 || change === 2 ? change : 0,
  }
}

const documentEnd = (text: string): LspPoint => {
  const lines = text.split("\n")
  const last = lines.at(-1) ?? ""
  const logicalLast = last.endsWith("\r") ? last.slice(0, -1) : last
  return { line: lines.length - 1, character: logicalLast.length }
}

class ManagedLanguageClient implements LanguageClient {
  readonly profile: ServerProfile
  readonly root: string
  readonly capabilities: Readonly<Record<string, unknown>>
  readonly #process: ChildProcessWithoutNullStreams
  readonly #rpc: JsonRpcConnection
  readonly #syncPolicy: TextDocumentSyncPolicy
  readonly #onClosed: (() => void) | undefined
  readonly #openDocuments = new Map<string, OpenDocument>()
  readonly #documentSyncTails = new Map<string, Promise<void>>()
  readonly #diagnostics = new Map<
    string,
    { readonly version: number; readonly value: unknown }
  >()
  readonly #diagnosticWaiters = new Map<string, Set<() => void>>()
  #disposed = false
  #closedNotified = false

  constructor(input: {
    readonly profile: ServerProfile
    readonly root: string
    readonly process: ChildProcessWithoutNullStreams
    readonly rpc: JsonRpcConnection
    readonly capabilities: Readonly<Record<string, unknown>>
    readonly onClosed?: () => void
  }) {
    this.profile = input.profile
    this.root = input.root
    this.#process = input.process
    this.#rpc = input.rpc
    this.capabilities = input.capabilities
    this.#syncPolicy = textDocumentSyncPolicy(input.capabilities)
    this.#onClosed = input.onClosed
  }

  static start(input: {
    readonly profile: ServerProfile
    readonly root: string
    readonly processFactory?: LspProcessFactory
    readonly onClosed?: () => void
  }): Effect.Effect<ManagedLanguageClient, LspClientError> {
    const factory = input.processFactory ?? defaultProcessFactory
    let child: ChildProcessWithoutNullStreams | undefined
    let rpc: JsonRpcConnection | undefined
    let client: ManagedLanguageClient | undefined
    const cleanup = (message: string) =>
      Effect.try({
        try: () => {
          rpc?.dispose(message)
          if (child?.exitCode === null) child.kill()
        },
        catch: asClientError,
      }).pipe(Effect.ignore)
    return Effect.gen(function* () {
      child = yield* Effect.try({
        try: () =>
          factory.spawn(input.profile.command, input.profile.args, {
            cwd: input.root,
            env: languageServerEnvironment(),
            detached: false,
          }),
        catch: cause =>
          clientError(
            "spawn_failed",
            `Could not start ${input.profile.command}`,
            cause,
          ),
      })
      yield* Effect.try({
        try: () => child?.stderr.resume(),
        catch: asClientError,
      })
      rpc = new JsonRpcConnection(child.stdout, child.stdin, {
        onNotification: (method, params) =>
          client?.handleNotification(method, params),
        onClose: () => {
          client?.markClosed()
          if (child?.exitCode === null) child.kill()
        },
      })
      child.once("error", cause => {
        rpc?.dispose(`Language server process failed: ${String(cause)}`)
        client?.markClosed()
      })
      child.once("exit", () => {
        rpc?.dispose("Language server process exited")
        client?.markClosed()
      })
      const initialize = yield* rpc
        .request("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(input.root).href,
          capabilities: {
            workspace: {
              applyEdit: false,
              workspaceEdit: {
                documentChanges: false,
                resourceOperations: [],
              },
            },
            textDocument: {
              synchronization: {
                dynamicRegistration: false,
                willSave: false,
                didSave: false,
              },
              definition: { linkSupport: true },
              references: {},
              rename: { prepareSupport: false },
              codeAction: {},
              publishDiagnostics: { relatedInformation: false },
            },
          },
          workspaceFolders: [
            { uri: pathToFileURL(input.root).href, name: input.root },
          ],
        })
        .pipe(
          Effect.mapError(cause =>
            clientError(
              "initialize_failed",
              `Could not initialize ${input.profile.command}`,
              cause,
            ),
          ),
        )
      if (!isRecord(initialize) || !isRecord(initialize.capabilities))
        return yield* Effect.fail(
          clientError(
            "initialize_failed",
            `${input.profile.command} returned malformed capabilities`,
          ),
        )
      client = new ManagedLanguageClient({
        profile: input.profile,
        root: input.root,
        process: child,
        rpc,
        capabilities: initialize.capabilities,
        ...(input.onClosed ? { onClosed: input.onClosed } : {}),
      })
      yield* rpc.notify("initialized", {}).pipe(Effect.mapError(asClientError))
      return client
    }).pipe(
      Effect.tapError(() => cleanup("Language server initialization failed")),
      Effect.onInterrupt(() =>
        cleanup("Language server initialization interrupted"),
      ),
    )
  }

  definition(
    file: string,
    point: LspPoint,
  ): Effect.Effect<unknown, LspClientError> {
    return this.#positionRequest(
      "definitionProvider",
      "definition",
      file,
      point,
    )
  }

  references(
    file: string,
    point: LspPoint,
  ): Effect.Effect<unknown, LspClientError> {
    return Effect.flatMap(this.#sync(file), uri =>
      Effect.flatMap(
        this.#requireCapability("referencesProvider", "references"),
        () =>
          Effect.mapError(
            this.#rpc.request("textDocument/references", {
              textDocument: { uri },
              position: point,
              context: { includeDeclaration: true },
            }),
            asClientError,
          ),
      ),
    )
  }

  diagnostics(file: string): Effect.Effect<unknown, LspClientError> {
    const uri = pathToFileURL(file).href
    const beforeDiagnosticsVersion = this.#diagnostics.get(uri)?.version ?? 0
    const beforeDocumentVersion = this.#openDocuments.get(uri)?.version
    return Effect.flatMap(this.#sync(file), () =>
      Effect.tryPromise({
        try: async () => {
          const current = this.#diagnostics.get(uri)
          const documentVersion = this.#openDocuments.get(uri)?.version
          const documentUnchanged =
            beforeDocumentVersion !== undefined &&
            documentVersion === beforeDocumentVersion
          if (
            current &&
            (current.version > beforeDiagnosticsVersion || documentUnchanged)
          )
            return current.value
          await new Promise<void>(resolve => {
            const waiters = this.#diagnosticWaiters.get(uri) ?? new Set()
            waiters.add(resolve)
            this.#diagnosticWaiters.set(uri, waiters)
            setTimeout(() => {
              waiters.delete(resolve)
              if (waiters.size === 0) this.#diagnosticWaiters.delete(uri)
              resolve()
            }, DIAGNOSTICS_WAIT_MS)
          })
          const latest = this.#diagnostics.get(uri)
          return latest && latest.version > beforeDiagnosticsVersion
            ? latest.value
            : undefined
        },
        catch: asClientError,
      }),
    )
  }

  rename(
    file: string,
    point: LspPoint,
    newName: string,
  ): Effect.Effect<unknown, LspClientError> {
    return Effect.flatMap(this.#sync(file), uri =>
      Effect.flatMap(this.#requireCapability("renameProvider", "rename"), () =>
        Effect.mapError(
          this.#rpc.request("textDocument/rename", {
            textDocument: { uri },
            position: point,
            newName,
          }),
          asClientError,
        ),
      ),
    )
  }

  codeActions(
    file: string,
    point: LspPoint,
  ): Effect.Effect<unknown, LspClientError> {
    return Effect.flatMap(this.#sync(file), uri =>
      Effect.flatMap(
        this.#requireCapability("codeActionProvider", "code actions"),
        () =>
          Effect.mapError(
            this.#rpc.request("textDocument/codeAction", {
              textDocument: { uri },
              range: { start: point, end: point },
              context: {
                diagnostics: this.#diagnosticsForUri(uri),
                triggerKind: 1,
              },
            }),
            asClientError,
          ),
      ),
    )
  }

  isClosed(): boolean {
    return this.#disposed || this.#process.exitCode !== null
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    if (this.#syncPolicy.openClose) {
      for (const uri of this.#openDocuments.keys()) {
        await Effect.runPromise(
          Effect.ignore(
            this.#rpc.notify("textDocument/didClose", {
              textDocument: { uri },
            }),
          ),
        )
      }
    }
    await Effect.runPromise(
      Effect.ignore(this.#rpc.request("shutdown", null, { timeoutMs: 500 })),
    )
    await Effect.runPromise(Effect.ignore(this.#rpc.notify("exit")))
    this.#rpc.dispose("Language server client disposed")
    if (this.#process.exitCode === null) this.#process.kill()
    this.markClosed()
  }

  markClosed(): void {
    if (this.#disposed && this.#closedNotified) return
    this.#disposed = true
    if (!this.#closedNotified) {
      this.#closedNotified = true
      this.#onClosed?.()
    }
    for (const waiters of this.#diagnosticWaiters.values()) {
      for (const waiter of waiters) waiter()
    }
    this.#diagnosticWaiters.clear()
    this.#documentSyncTails.clear()
  }

  handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics" || !isRecord(params))
      return
    if (typeof params.uri !== "string" || !Array.isArray(params.diagnostics))
      return
    const document = this.#openDocuments.get(params.uri)
    if (!document) return
    if (params.version === undefined && document.version > 1) return
    if (
      params.version !== undefined &&
      (typeof params.version !== "number" ||
        !Number.isSafeInteger(params.version) ||
        params.version !== document.version)
    )
      return
    const previous = this.#diagnostics.get(params.uri)?.version ?? 0
    this.#diagnostics.set(params.uri, {
      version: previous + 1,
      value: params.diagnostics.slice(0, MAX_DIAGNOSTICS),
    })
    const waiters = this.#diagnosticWaiters.get(params.uri)
    if (!waiters) return
    this.#diagnosticWaiters.delete(params.uri)
    for (const waiter of waiters) waiter()
  }

  #positionRequest(
    capability: string,
    label: string,
    file: string,
    point: LspPoint,
  ): Effect.Effect<unknown, LspClientError> {
    return Effect.flatMap(this.#sync(file), uri =>
      Effect.flatMap(this.#requireCapability(capability, label), () =>
        Effect.mapError(
          this.#rpc.request(`textDocument/${label}`, {
            textDocument: { uri },
            position: point,
          }),
          asClientError,
        ),
      ),
    )
  }

  #requireCapability(
    capability: string,
    label: string,
  ): Effect.Effect<void, LspClientError> {
    return capabilityEnabled(this.capabilities, capability)
      ? Effect.void
      : Effect.fail(
          clientError(
            "unsupported_capability",
            `${this.profile.command} does not advertise ${label}`,
          ),
        )
  }

  #sync(file: string): Effect.Effect<string, LspClientError> {
    if (this.#disposed)
      return Effect.fail(
        clientError("closed", "Language server client is closed"),
      )
    if (this.#syncPolicy.change === 0)
      return Effect.fail(
        clientError(
          "unsupported_capability",
          `${this.profile.command} does not advertise text document synchronization`,
        ),
      )
    const uri = pathToFileURL(file).href
    return Effect.gen(this, function* () {
      const { text } = yield* Effect.tryPromise({
        try: () => readBoundedRegularText(file, MAX_SYNC_BYTES),
        catch: asClientError,
      })
      const digest = sha256(text)
      yield* this.#serializeDocumentSync(uri, () =>
        Effect.gen(this, function* () {
          const previous = this.#openDocuments.get(uri)
          if (!previous) {
            if (this.#openDocuments.size >= MAX_OPEN_DOCUMENTS)
              return yield* Effect.fail(
                clientError(
                  "request_failed",
                  `LSP client already tracks ${MAX_OPEN_DOCUMENTS} open documents`,
                ),
              )
            const opened = { version: 1, digest, text }
            this.#openDocuments.set(uri, opened)
            if (this.#syncPolicy.openClose)
              yield* this.#rpc
                .notify("textDocument/didOpen", {
                  textDocument: {
                    uri,
                    languageId: this.profile.languageId(file),
                    version: opened.version,
                    text,
                  },
                })
                .pipe(
                  Effect.mapError(asClientError),
                  Effect.tapError(() =>
                    Effect.sync(() => this.#openDocuments.delete(uri)),
                  ),
                )
            return
          }
          if (previous.digest === digest) return
          const next = { version: previous.version + 1, digest, text }
          this.#openDocuments.set(uri, next)
          yield* this.#rpc
            .notify("textDocument/didChange", {
              textDocument: { uri, version: next.version },
              contentChanges:
                this.#syncPolicy.change === 1
                  ? [{ text }]
                  : [
                      {
                        range: {
                          start: { line: 0, character: 0 },
                          end: documentEnd(previous.text),
                        },
                        text,
                      },
                    ],
            })
            .pipe(
              Effect.mapError(asClientError),
              Effect.tapError(() =>
                Effect.sync(() => this.#openDocuments.set(uri, previous)),
              ),
            )
        }),
      )
      return uri
    })
  }

  #serializeDocumentSync<T>(
    uri: string,
    work: () => Effect.Effect<T, LspClientError>,
  ): Effect.Effect<T, LspClientError> {
    const previous = this.#documentSyncTails.get(uri) ?? Promise.resolve()
    let release = (): void => {}
    const done = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => done)
    this.#documentSyncTails.set(uri, tail)
    return Effect.tryPromise({
      try: () => previous,
      catch: asClientError,
    }).pipe(
      Effect.flatMap(work),
      Effect.ensuring(
        Effect.sync(() => {
          release()
          if (this.#documentSyncTails.get(uri) === tail)
            this.#documentSyncTails.delete(uri)
        }),
      ),
    )
  }

  #diagnosticsForUri(uri: string): readonly unknown[] {
    const value = this.#diagnostics.get(uri)?.value
    return Array.isArray(value) ? value : []
  }
}

export const startLanguageClient = (input: {
  readonly profile: ServerProfile
  readonly root: string
  readonly processFactory?: LspProcessFactory
  readonly onClosed?: () => void
}): Effect.Effect<LanguageClient, LspClientError> =>
  ManagedLanguageClient.start(input)

export class LanguageClientPool {
  readonly #clients = new Map<string, Promise<LanguageClient>>()
  readonly #processFactory: LspProcessFactory | undefined

  constructor(processFactory?: LspProcessFactory) {
    this.#processFactory = processFactory
  }

  get(
    profile: ServerProfile,
    root: string,
  ): Effect.Effect<LanguageClient, LspClientError> {
    const key = `${profile.id}:${root}`
    let client = this.#clients.get(key)
    if (!client) {
      let created: Promise<LanguageClient>
      created = Effect.runPromise(
        startLanguageClient({
          profile,
          root,
          ...(this.#processFactory
            ? { processFactory: this.#processFactory }
            : {}),
          onClosed: () => {
            if (this.#clients.get(key) === created) this.#clients.delete(key)
          },
        }),
      )
      client = created
      this.#clients.set(key, client)
      void client.catch(() => {
        if (this.#clients.get(key) === created) this.#clients.delete(key)
      })
    }
    return Effect.tryPromise({
      try: () => client,
      catch: asClientError,
    }).pipe(
      Effect.flatMap(resolved => {
        if (!resolved.isClosed()) return Effect.succeed(resolved)
        if (this.#clients.get(key) === client) this.#clients.delete(key)
        return Effect.fail(
          clientError("closed", "Cached language server process exited"),
        )
      }),
    )
  }

  status(): readonly { readonly profile: string; readonly root: string }[] {
    return [...this.#clients.keys()].map(key => {
      const separator = key.indexOf(":")
      return {
        profile: key.slice(0, separator),
        root: key.slice(separator + 1),
      }
    })
  }

  async dispose(): Promise<void> {
    const clients = [...this.#clients.values()]
    this.#clients.clear()
    await Promise.all(
      clients.map(async pending => {
        try {
          await (await pending).dispose()
        } catch {
          // Startup already failed or shutdown raced process exit.
        }
      }),
    )
  }
}
