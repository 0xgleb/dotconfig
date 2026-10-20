import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import type {
  DeliveryResult,
  DispatchDecision,
  InputDeliveryBinding,
  ModelInputDispatch,
} from "../../host/model-input-delivery.ts"
import {
  createOwnerAllowance,
  OWNER_ALLOWANCE_ENTRY,
  OWNER_PARENT_DEADLINE_ENV,
  OwnerAllowanceError,
} from "./owner-allowance.ts"

interface NativeDeliveryBinding extends InputDeliveryBinding {
  readonly expireActiveRun?: () => void
}
interface NativeDeliveryHost {
  readonly registerModelInputDeliveryGuard?: (
    handler: (
      dispatch: ModelInputDispatch,
      context: ExtensionContext,
    ) => DispatchDecision,
  ) => DeliveryResult<NativeDeliveryBinding>
}

/** Always on; delivery-time renewal requires the host's private provenance API. */
export const registerOwnerAllowance = (
  pi: ExtensionAPI,
  cancelBackground: (reason: OwnerAllowanceError) => void,
) => {
  let context: ExtensionContext | undefined
  let inputDelivery: NativeDeliveryBinding | undefined
  const deliveryHost: ExtensionAPI & NativeDeliveryHost = pi
  const guard = createOwnerAllowance({
    inheritedDeadline: process.env[OWNER_PARENT_DEADLINE_ENV],
    now: () => Date.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    clear: handle => clearTimeout(handle),
    persist: window => pi.appendEntry(OWNER_ALLOWANCE_ENTRY, window),
    cancel: reason => {
      const results = [
        () => cancelBackground(reason),
        () => {
          if (
            reason.code === "expired" &&
            typeof inputDelivery?.expireActiveRun === "function"
          )
            inputDelivery.expireActiveRun()
        },
        () => context?.abort(),
        () =>
          context?.ui.setStatus(
            "owner-allowance",
            `autonomy: ${reason.code} · owner input required`,
          ),
      ].map(action =>
        Either.try({
          try: action,
          catch: () =>
            new OwnerAllowanceError({
              code: "runtime-failure",
              message:
                "Owner allowance cancellation boundary failed; execution remains denied.",
            }),
        }),
      )
      return results.find(Either.isLeft)?.left
    },
  })
  const allowed = (ctx: ExtensionContext) => {
    context = ctx
    return guard.admit()
  }
  const registerDelivery = deliveryHost.registerModelInputDeliveryGuard
  const registration =
    registerDelivery === undefined
      ? undefined
      : Either.try({
          try: () =>
            registerDelivery(
              (dispatch: ModelInputDispatch, ctx: ExtensionContext) => {
                context = ctx
                if (
                  !inputDelivery ||
                  !Array.isArray(dispatch.ownerInputIds) ||
                  !dispatch.ownerInputIds.every(
                    (id: unknown) =>
                      typeof id === "string" &&
                      inputDelivery?.isInputAuthorized(id) === true,
                  )
                )
                  return {
                    action: "block",
                    reason: "Model input delivery provenance is invalid.",
                  }
                if (dispatch.ownerInputIds.length > 0) {
                  const renewed = guard.ownerInput(dispatch.dispatchedAt)
                  if (Either.isLeft(renewed))
                    return { action: "block", reason: renewed.left.message }
                }
                const admitted = allowed(ctx)
                return Either.isRight(admitted)
                  ? { action: "allow" }
                  : { action: "block", reason: admitted.left.message }
              },
            ),
          catch: () =>
            new OwnerAllowanceError({
              code: "runtime-failure",
              message: "Native model input delivery registration failed.",
            }),
        })
  if (
    registration &&
    Either.isRight(registration) &&
    registration.right?.ok === true &&
    typeof registration.right.value?.authorizeInput === "function" &&
    typeof registration.right.value?.isInputAuthorized === "function"
  )
    inputDelivery = registration.right.value
  const timing = inputDelivery
    ? "model-dispatch"
    : registration === undefined
      ? "legacy-input"
      : "unavailable"
  if (timing === "unavailable") guard.dispose()

  pi.on("session_start", (_event, ctx) => {
    context = ctx
    const latest = ctx.sessionManager
      .getEntries()
      .findLast(
        entry =>
          entry.type === "custom" && entry.customType === OWNER_ALLOWANCE_ENTRY,
      )
    guard.restore(latest?.type === "custom" ? latest.data : undefined)
    if (timing === "unavailable") {
      guard.dispose()
      ctx.ui.setStatus(
        "owner-allowance",
        "autonomy: blocked · native delivery registration failed",
      )
      ctx.ui.notify(
        "Native owner-delivery guard registration failed; work remains denied.",
        "warning",
      )
    }
    if (timing === "legacy-input")
      ctx.ui.setStatus(
        "owner-allowance",
        "autonomy: legacy ingress timing · native delivery host activation pending",
      )
  })
  pi.on("input", (event, ctx) => {
    context = ctx
    const inputId =
      "inputId" in event && typeof event.inputId === "string"
        ? event.inputId
        : undefined
    if (timing === "unavailable") return { action: "handled" }
    if (
      event.source === "interactive" &&
      (event.text.trim() ||
        (Array.isArray(event.images) && event.images.length > 0))
    ) {
      if (inputDelivery) {
        if (!inputId) {
          ctx.ui.notify(
            "Owner input was not queued: native delivery receipt is missing.",
            "warning",
          )
          return { action: "handled" }
        }
        const authorized = inputDelivery.authorizeInput(inputId)
        if (!authorized.ok) {
          ctx.ui.notify(authorized.error.message, "warning")
          return { action: "handled" }
        }
        ctx.ui.setStatus(
          "owner-allowance",
          "autonomy: owner input queued · renewal waits for model dispatch",
        )
        return { action: "continue" }
      }
      const granted = guard.ownerInput(Date.now())
      if (Either.isRight(granted))
        ctx.ui.setStatus(
          "owner-allowance",
          `autonomy: legacy ingress · deadline ${granted.right.deadlineAt}`,
        )
      return { action: "continue" }
    }
    if (inputId && inputDelivery?.isInputAuthorized(inputId))
      return { action: "continue" }
    if (Either.isLeft(guard.admit())) return { action: "handled" }
    return { action: "continue" }
  })
  pi.on("tool_call", (_event, ctx) => {
    const result = allowed(ctx)
    if (Either.isLeft(result))
      return { block: true, reason: result.left.message }
  })
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx
    const inputId =
      "inputId" in event && typeof event.inputId === "string"
        ? event.inputId
        : undefined
    // Stage only this authenticated input's dispatch; tools and unrelated work
    // still have no allowance until the native dispatch guard commits delivery.
    if (inputId && inputDelivery?.isInputAuthorized(inputId)) return
    if (Either.isLeft(allowed(ctx))) ctx.abort()
  })
  pi.on("before_provider_request", (event, ctx) => {
    const admitted = allowed(ctx)
    if (Either.isLeft(admitted)) ctx.abort()
    else if (timing === "model-dispatch")
      ctx.ui.setStatus(
        "owner-allowance",
        `autonomy: model dispatch · deadline ${admitted.right.deadlineAt}`,
      )
    return event.payload
  })
  pi.on("session_before_compact", (_event, ctx) => {
    if (Either.isLeft(allowed(ctx))) return { cancel: true }
  })
  pi.on("session_before_tree", (event, ctx) => {
    if (event.preparation.userWantsSummary && Either.isLeft(allowed(ctx)))
      return { cancel: true }
  })
  pi.on("cache_warming_decision", (_event, ctx) => {
    // The SDK warmer owns a separate controller that ctx.abort() does not
    // cancel. Fail closed: do not start work this guard cannot stop at expiry.
    allowed(ctx)
    return { action: "stop" }
  })
  pi.on("session_shutdown", () => {
    guard.dispose()
    context = undefined
  })
  pi.registerCommand("autonomy", {
    description:
      "Show the enforced owner deadline; this command never renews it",
    handler: async (_args, ctx) => {
      const result = allowed(ctx)
      ctx.ui.notify(
        Either.isLeft(result)
          ? result.left.message
          : `Owner deadline (${timing}): ${new Date(result.right.deadlineAt).toISOString()}`,
        "info",
      )
    },
  })
  return Object.freeze({ ...guard, inputDelivery, timing })
}
