import { createHash } from "node:crypto"

export type InputSource = "interactive" | "rpc" | "extension"
export type DeliveryErrorCode =
  | "invalid-id"
  | "invalid-source"
  | "already-associated"
  | "duplicate-id"
  | "unknown-input"
  | "cancelled-input"
  | "invalid-message"
  | "mutated-input"
  | "guard-conflict"
  | "guard-unavailable"
  | "guard-failed"
  | "invalid-decision"
  | "denied"
  | "cancelled"
  | "invalid-clock"
  | "dispatch-failed"

export interface DeliveryError {
  readonly code: DeliveryErrorCode
  readonly message: string
}
export type DeliveryResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: DeliveryError }

export interface InputReceipt {
  readonly id: string
}
export interface ModelInputDispatch {
  readonly dispatchId: string
  readonly dispatchedAt: number
  readonly ownerInputIds: readonly string[]
}
export type DispatchDecision =
  | { readonly action: "allow" }
  | { readonly action: "block"; readonly reason: string }
export type ModelInputGuard = (dispatch: ModelInputDispatch) => DispatchDecision
export interface InputDeliveryBinding {
  readonly authorizeInput: (id: string) => DeliveryResult<void>
  readonly isInputAuthorized: (id: string) => boolean
}

interface PendingInput {
  readonly receipt: InputReceipt
  readonly source: InputSource
  phase: "accepted" | "queued" | "prepared" | "consumed" | "cancelled"
  authority: string | undefined
  digest: string | undefined
}

const success = <A>(value: A): DeliveryResult<A> => ({ ok: true, value })
const failure = (code: DeliveryErrorCode): DeliveryResult<never> => ({
  ok: false,
  error: { code, message: `Model input delivery failed: ${code}.` },
})
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Hash only validated semantic content, never arbitrary extra message fields.
const inputDigest = (message: unknown): DeliveryResult<string> => {
  if (!record(message) || message.role !== "user")
    return failure("invalid-message")
  const content = message.content
  const parts: unknown[] = []
  if (typeof content === "string") parts.push({ type: "text", text: content })
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!record(part)) return failure("invalid-message")
      if (part.type === "text" && typeof part.text === "string")
        parts.push({ type: "text", text: part.text })
      else if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      )
        parts.push({ type: "image", data: part.data, mimeType: part.mimeType })
      else return failure("invalid-message")
    }
  } else return failure("invalid-message")
  return success(
    createHash("sha256").update(JSON.stringify(parts)).digest("hex"),
  )
}

/** Host-owned provenance. Never reconstruct authority by matching message text. */
export const createModelInputDelivery = (runtime: {
  readonly now: () => number
  readonly newId: () => string
}) => {
  const receipts = new WeakMap<object, PendingInput>()
  const messages = new WeakMap<object, PendingInput>()
  const pending = new Map<string, PendingInput>()
  const usedIds = new Set<string>()
  let sourceId: string | undefined
  let guard: ModelInputGuard | undefined
  let fault: DeliveryErrorCode | undefined
  let lastDispatchAt: number | undefined

  const newId = (): DeliveryResult<string> => {
    let id: string
    try {
      id = runtime.newId()
    } catch {
      return failure("invalid-id")
    }
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      return failure("invalid-id")
    if (usedIds.has(id)) return failure("duplicate-id")
    usedIds.add(id)
    return success(id)
  }
  const active = (input: PendingInput) =>
    input.phase !== "consumed" && input.phase !== "cancelled"

  return {
    acceptInput: (source: InputSource): DeliveryResult<InputReceipt> => {
      if (
        source !== "interactive" &&
        source !== "rpc" &&
        source !== "extension"
      )
        return failure("invalid-source")
      const id = newId()
      if (!id.ok) return id
      const receipt = Object.freeze({ id: id.value })
      const input: PendingInput = {
        receipt,
        source,
        phase: "accepted",
        authority: undefined,
        digest: undefined,
      }
      receipts.set(receipt, input)
      pending.set(receipt.id, input)
      return success(receipt)
    },
    associate: (
      receipt: InputReceipt,
      message: object,
      queued: boolean,
    ): DeliveryResult<void> => {
      const input = receipts.get(receipt)
      if (!input) return failure("unknown-input")
      if (!active(input)) return failure("cancelled-input")
      if (input.digest !== undefined) return failure("already-associated")
      const digest = inputDigest(message)
      if (!digest.ok) return digest
      input.digest = digest.value
      input.phase = queued ? "queued" : "prepared"
      messages.set(message, input)
      return success(undefined)
    },
    prepareMessage: (message: object): void => {
      const input = messages.get(message)
      if (input?.phase === "queued") input.phase = "prepared"
    },
    preserveClone: (original: object, clone: object): DeliveryResult<void> => {
      const input = messages.get(original)
      if (!input || !active(input)) return success(undefined)
      const before = inputDigest(original)
      const after = inputDigest(clone)
      if (!before.ok) return before
      if (!after.ok) return after
      if (before.value !== input.digest || after.value !== input.digest)
        return failure("mutated-input")
      messages.set(clone, input)
      return success(undefined)
    },
    cancelInput: (receipt: InputReceipt): DeliveryResult<void> => {
      const input = receipts.get(receipt)
      if (!input) return failure("unknown-input")
      if (input.phase !== "consumed") {
        input.phase = "cancelled"
        pending.delete(receipt.id)
      }
      return success(undefined)
    },
    clearQueued: (): void => {
      for (const input of pending.values()) {
        if (input.phase === "queued") {
          input.phase = "cancelled"
          pending.delete(input.receipt.id)
        }
      }
    },
    beginGuardReload: (): void => {
      guard = undefined
      fault = undefined
    },
    registerGuard: (
      extensionSource: string,
      handler: ModelInputGuard,
    ): DeliveryResult<InputDeliveryBinding> => {
      if (
        !extensionSource ||
        (sourceId !== undefined && sourceId !== extensionSource)
      ) {
        fault = "guard-conflict"
        return failure("guard-conflict")
      }
      sourceId = extensionSource
      guard = handler
      return success(
        Object.freeze({
          authorizeInput: (id: string): DeliveryResult<void> => {
            const input = pending.get(id)
            if (!input) return failure("unknown-input")
            if (!active(input)) return failure("cancelled-input")
            input.authority = extensionSource
            return success(undefined)
          },
          isInputAuthorized: (id: string) => {
            const input = pending.get(id)
            return (
              input !== undefined &&
              active(input) &&
              input.authority === extensionSource
            )
          },
        }),
      )
    },
    dispatch: <A>(
      contextMessages: readonly object[],
      send: (commit: ModelInputDispatch) => A,
      signal?: AbortSignal,
    ): DeliveryResult<A> => {
      if (signal?.aborted) return failure("cancelled")
      if (fault) return failure(fault)
      if (sourceId !== undefined && guard === undefined)
        return failure("guard-unavailable")
      const included = new Set<PendingInput>()
      for (const message of contextMessages) {
        const input = messages.get(message)
        if (!input || !active(input)) continue
        const digest = inputDigest(message)
        if (!digest.ok) return digest
        if (digest.value !== input.digest) return failure("mutated-input")
        included.add(input)
      }
      let now: number
      try {
        now = runtime.now()
      } catch {
        return failure("invalid-clock")
      }
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        now > 8_640_000_000_000_000 ||
        (lastDispatchAt !== undefined && now < lastDispatchAt)
      )
        return failure("invalid-clock")
      const id = newId()
      if (!id.ok) return id
      const commit: ModelInputDispatch = Object.freeze({
        dispatchId: id.value,
        dispatchedAt: now,
        ownerInputIds: Object.freeze(
          [...included]
            .filter(
              input => sourceId !== undefined && input.authority === sourceId,
            )
            .map(input => input.receipt.id),
        ),
      })
      if (guard) {
        let decision: DispatchDecision
        try {
          decision = guard(commit)
        } catch {
          return failure("guard-failed")
        }
        if (
          !record(decision) ||
          (decision.action !== "allow" && decision.action !== "block")
        )
          return failure("invalid-decision")
        if (decision.action === "block") {
          if (typeof decision.reason !== "string" || !decision.reason.trim())
            return failure("invalid-decision")
          return {
            ok: false,
            error: { code: "denied", message: decision.reason },
          }
        }
      }
      if (signal?.aborted) return failure("cancelled")
      // Synchronous commit/handoff: no await can admit another turn between these.
      for (const input of included) {
        input.phase = "consumed"
        pending.delete(input.receipt.id)
      }
      lastDispatchAt = now
      try {
        return success(send(commit))
      } catch {
        return failure("dispatch-failed")
      }
    },
  }
}
