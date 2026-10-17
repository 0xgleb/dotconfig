import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import {
  createOwnerAllowance,
  OWNER_ALLOWANCE_ENTRY,
  OWNER_PARENT_DEADLINE_ENV,
  OwnerAllowanceError,
} from "./owner-allowance.ts"

/** Always on. Only the authenticated input boundary can grant a new window. */
export const registerOwnerAllowance = (
  pi: ExtensionAPI,
  cancelBackground: (reason: OwnerAllowanceError) => void,
) => {
  let context: ExtensionContext | undefined
  const guard = createOwnerAllowance({
    inheritedDeadline: process.env[OWNER_PARENT_DEADLINE_ENV],
    now: () => Date.now(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    clear: handle => clearTimeout(handle),
    persist: window => pi.appendEntry(OWNER_ALLOWANCE_ENTRY, window),
    cancel: reason => {
      const results = [
        () => cancelBackground(reason),
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
  pi.on("session_start", (_event, ctx) => {
    context = ctx
    const latest = ctx.sessionManager
      .getEntries()
      .findLast(
        entry =>
          entry.type === "custom" && entry.customType === OWNER_ALLOWANCE_ENTRY,
      )
    guard.restore(latest?.type === "custom" ? latest.data : undefined)
  })
  pi.on("input", (event, ctx) => {
    context = ctx
    if (event.source === "interactive" && event.text.trim()) {
      const granted = guard.ownerInput(Date.now())
      if (Either.isRight(granted))
        ctx.ui.setStatus(
          "owner-allowance",
          `autonomy: enforced · deadline ${granted.right.deadlineAt}`,
        )
      return { action: "continue" }
    }
    if (Either.isLeft(guard.admit())) return { action: "handled" }
    return { action: "continue" }
  })
  pi.on("tool_call", (_event, ctx) => {
    const result = allowed(ctx)
    if (Either.isLeft(result))
      return { block: true, reason: result.left.message }
  })
  pi.on("before_agent_start", (_event, ctx) => {
    if (Either.isLeft(allowed(ctx))) ctx.abort()
  })
  pi.on("before_provider_request", (event, ctx) => {
    if (Either.isLeft(allowed(ctx))) ctx.abort()
    return event.payload
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
          : `Owner deadline: ${new Date(result.right.deadlineAt).toISOString()}`,
        "info",
      )
    },
  })
  return guard
}
