import type { Readable, Writable } from "node:stream"
import { Data, Effect } from "effect"

const DEFAULT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_PENDING = 128
const MAX_HEADER_BYTES = 8 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024

type JsonRpcId = number | string

export type LspRpcErrorCode =
  | "closed"
  | "invalid_frame"
  | "message_too_large"
  | "invalid_message"
  | "pending_limit"
  | "timeout"
  | "server_error"
  | "write_failed"

export class LspRpcError extends Data.TaggedError("LspRpcError")<{
  readonly code: LspRpcErrorCode
  readonly message: string
  readonly cause?: unknown
  readonly serverCode?: number
  readonly serverDiagnostic?: string
}> {}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: unknown
}

interface PendingRequest {
  readonly method: string
  readonly resume: (effect: Effect.Effect<unknown, LspRpcError>) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface JsonRpcConnectionOptions {
  readonly maxMessageBytes?: number
  readonly maxPending?: number
  readonly onNotification?: (method: string, params: unknown) => void
  readonly onClose?: (error: LspRpcError) => void
  readonly onRequest?: (
    method: string,
    params: unknown,
  ) => Promise<unknown> | unknown
}

const rpcError = (
  code: LspRpcErrorCode,
  message: string,
  cause?: unknown,
  server?: {
    readonly code: number
    readonly diagnostic: string
  },
): LspRpcError =>
  new LspRpcError({
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

const boundedServerDiagnostic = (value: string): string => {
  const diagnostic = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500)
  return diagnostic.length > 0
    ? diagnostic
    : "Language server rejected the request without a diagnostic"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  (typeof value === "number" && Number.isSafeInteger(value)) ||
  (typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value))

export class JsonRpcConnection {
  readonly #input: Readable
  readonly #output: Writable
  readonly #maxMessageBytes: number
  readonly #maxPending: number
  readonly #onNotification?: JsonRpcConnectionOptions["onNotification"]
  readonly #onClose?: JsonRpcConnectionOptions["onClose"]
  readonly #onRequest?: JsonRpcConnectionOptions["onRequest"]
  readonly #pending = new Map<number, PendingRequest>()
  readonly #outbound: Buffer<ArrayBufferLike>[] = []
  #outboundBytes = 0
  #waitingForDrain = false
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  #nextId = 1
  #closed = false

  readonly #handleData = (chunk: Buffer | string): void => {
    if (this.#closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.#buffer =
      this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes])
    this.#drainFrames()
  }

  readonly #handleInputError = (cause: unknown): void => {
    this.#failAll(rpcError("closed", "LSP input stream failed", cause))
  }

  readonly #handleInputEnd = (): void => {
    this.#failAll(rpcError("closed", "LSP input stream closed"))
  }

  readonly #handleOutputError = (cause: unknown): void => {
    this.#failAll(rpcError("write_failed", "LSP output stream failed", cause))
  }

  readonly #handleDrain = (): void => {
    this.#waitingForDrain = false
    this.#flushWrites()
  }

  constructor(
    input: Readable,
    output: Writable,
    options: JsonRpcConnectionOptions = {},
  ) {
    this.#input = input
    this.#output = output
    this.#maxMessageBytes = Math.max(
      1,
      Math.floor(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
    )
    this.#maxPending = Math.max(
      1,
      Math.floor(options.maxPending ?? DEFAULT_MAX_PENDING),
    )
    this.#onNotification = options.onNotification
    this.#onClose = options.onClose
    this.#onRequest = options.onRequest
    input.on("data", this.#handleData)
    input.once("error", this.#handleInputError)
    input.once("end", this.#handleInputEnd)
    input.once("close", this.#handleInputEnd)
    output.once("error", this.#handleOutputError)
  }

  request(
    method: string,
    params?: unknown,
    options: { readonly timeoutMs?: number } = {},
  ): Effect.Effect<unknown, LspRpcError> {
    return Effect.async<unknown, LspRpcError>(resume => {
      if (this.#closed) {
        resume(Effect.fail(rpcError("closed", "LSP connection is closed")))
        return
      }
      if (this.#pending.size >= this.#maxPending) {
        resume(
          Effect.fail(
            rpcError(
              "pending_limit",
              `LSP connection already has ${this.#maxPending} pending requests`,
            ),
          ),
        )
        return
      }
      const id = this.#nextId
      this.#nextId += 1
      const timeoutMs = Math.max(
        1,
        Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      )
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        this.#send({
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: { id },
        })
        pending.resume(
          Effect.fail(
            rpcError(
              "timeout",
              `LSP request ${pending.method} timed out after ${timeoutMs}ms`,
            ),
          ),
        )
      }, timeoutMs)
      this.#pending.set(id, { method, resume, timer })
      const sent = this.#send({ jsonrpc: "2.0", id, method, params })
      if (!sent) {
        clearTimeout(timer)
        this.#pending.delete(id)
        resume(
          Effect.fail(rpcError("write_failed", "Could not write LSP request")),
        )
      }
      return Effect.sync(() => {
        const pending = this.#pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pending.delete(id)
        this.#send({
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: { id },
        })
      })
    })
  }

  notify(method: string, params?: unknown): Effect.Effect<void, LspRpcError> {
    return this.#closed
      ? Effect.fail(rpcError("closed", "LSP connection is closed"))
      : this.#send({ jsonrpc: "2.0", method, params })
        ? Effect.void
        : Effect.fail(
            rpcError("write_failed", "Could not write LSP notification"),
          )
  }

  dispose(reason = "LSP connection disposed"): void {
    this.#failAll(rpcError("closed", reason))
  }

  #drainFrames(): void {
    while (!this.#closed) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) {
        if (this.#buffer.length > MAX_HEADER_BYTES)
          this.#failAll(
            rpcError("invalid_frame", "LSP frame header exceeds the limit"),
          )
        return
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        this.#failAll(
          rpcError("invalid_frame", "LSP frame header exceeds the limit"),
        )
        return
      }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii")
      const match = /^Content-Length:\s*(\d+)\s*$/imu.exec(header)
      if (!match?.[1]) {
        this.#failAll(
          rpcError("invalid_frame", "LSP frame is missing Content-Length"),
        )
        return
      }
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length < 0) {
        this.#failAll(
          rpcError("invalid_frame", "LSP Content-Length is invalid"),
        )
        return
      }
      if (length > this.#maxMessageBytes) {
        this.#failAll(
          rpcError(
            "message_too_large",
            `LSP message exceeds ${this.#maxMessageBytes} bytes`,
          ),
        )
        return
      }
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (this.#buffer.length < bodyEnd) return
      const body = this.#buffer.subarray(bodyStart, bodyEnd)
      this.#buffer = this.#buffer.subarray(bodyEnd)
      let message: unknown
      try {
        message = JSON.parse(body.toString("utf8"))
      } catch (cause) {
        this.#failAll(
          rpcError("invalid_message", "LSP message is not valid JSON", cause),
        )
        return
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message: unknown): void {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.#failAll(
        rpcError("invalid_message", "LSP message is not JSON-RPC 2.0"),
      )
      return
    }
    if (typeof message.method === "string") {
      if (isJsonRpcId(message.id)) {
        void this.#handleServerRequest(
          message.id,
          message.method,
          message.params,
        )
      } else if (message.id === undefined) {
        this.#onNotification?.(message.method, message.params)
      } else {
        this.#failAll(
          rpcError("invalid_message", "LSP server request ID is invalid"),
        )
      }
      return
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      this.#failAll(
        rpcError("invalid_message", "LSP response ID must be a safe integer"),
      )
      return
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return
    const hasResult = Object.hasOwn(message, "result")
    const hasError = Object.hasOwn(message, "error")
    if (hasResult === hasError) {
      this.#failAll(
        rpcError(
          "invalid_message",
          "LSP response must contain exactly one of result or error",
        ),
      )
      return
    }
    if (
      hasError &&
      (!isRecord(message.error) ||
        typeof message.error.code !== "number" ||
        !Number.isSafeInteger(message.error.code) ||
        typeof message.error.message !== "string")
    ) {
      this.#failAll(
        rpcError("invalid_message", "LSP error response is malformed"),
      )
      return
    }
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if (hasError && isRecord(message.error)) {
      const serverCode = message.error.code as number
      const diagnostic = boundedServerDiagnostic(
        message.error.message as string,
      )
      pending.resume(
        Effect.fail(
          rpcError(
            "server_error",
            `LSP ${pending.method} failed: ${diagnostic}`,
            undefined,
            { code: serverCode, diagnostic },
          ),
        ),
      )
      return
    }
    pending.resume(Effect.succeed(message.result))
  }

  async #handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method === "workspace/applyEdit") {
      this.#send({
        jsonrpc: "2.0",
        id,
        result: {
          applied: false,
          failureReason: "LSP edits require a digest-bound tool preview",
        },
      })
      return
    }
    if (method === "workspace/configuration") {
      this.#send({ jsonrpc: "2.0", id, result: [] })
      return
    }
    if (this.#onRequest) {
      try {
        const result = await this.#onRequest(method, params)
        this.#send({ jsonrpc: "2.0", id, result })
      } catch (cause) {
        this.#send({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: String(cause).slice(0, 500) },
        })
      }
      return
    }
    this.#send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported server request: ${method}` },
    })
  }

  #send(message: JsonRpcRequest | JsonRpcNotification | unknown): boolean {
    if (this.#closed) return false
    try {
      const body = Buffer.from(JSON.stringify(message), "utf8")
      if (body.length > this.#maxMessageBytes) return false
      const header = Buffer.from(
        `Content-Length: ${body.length}\r\n\r\n`,
        "ascii",
      )
      const framed = Buffer.concat([header, body])
      if (this.#outboundBytes + framed.length > MAX_OUTBOUND_QUEUE_BYTES) {
        this.#failAll(
          rpcError("write_failed", "LSP outbound queue exceeds its byte limit"),
        )
        return false
      }
      this.#outbound.push(framed)
      this.#outboundBytes += framed.length
      this.#flushWrites()
      return true
    } catch (cause) {
      this.#failAll(
        rpcError("write_failed", "Could not serialize LSP message", cause),
      )
      return false
    }
  }

  #flushWrites(): void {
    if (this.#closed || this.#waitingForDrain) return
    while (this.#outbound.length > 0) {
      const framed = this.#outbound.shift()
      if (!framed) return
      this.#outboundBytes -= framed.length
      if (!this.#output.write(framed)) {
        this.#waitingForDrain = true
        this.#output.once("drain", this.#handleDrain)
        return
      }
    }
  }

  #failAll(cause: LspRpcError): void {
    if (this.#closed) return
    this.#closed = true
    this.#input.off("data", this.#handleData)
    this.#input.off("error", this.#handleInputError)
    this.#input.off("end", this.#handleInputEnd)
    this.#input.off("close", this.#handleInputEnd)
    this.#output.off("error", this.#handleOutputError)
    this.#output.off("drain", this.#handleDrain)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.resume(Effect.fail(cause))
    }
    this.#pending.clear()
    this.#outbound.length = 0
    this.#outboundBytes = 0
    this.#waitingForDrain = false
    this.#buffer = Buffer.alloc(0)
    this.#onClose?.(cause)
  }
}
