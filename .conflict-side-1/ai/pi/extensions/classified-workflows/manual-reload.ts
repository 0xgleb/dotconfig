export type ReloadInitiator = "reload_pi" | "reload-runtime"

export interface ReloadCommandRequest {
  readonly requestId: string
  readonly initiator: ReloadInitiator
}

const TOOL_REQUEST_PATTERN =
  /^tool:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i

export const reloadCommandRequest = (
  args: string,
  createRequestId: () => string,
): ReloadCommandRequest => {
  const toolRequest = TOOL_REQUEST_PATTERN.exec(args.trim())
  return toolRequest?.[1]
    ? { requestId: toolRequest[1].toLowerCase(), initiator: "reload_pi" }
    : { requestId: createRequestId(), initiator: "reload-runtime" }
}

const boundedErrorText = (value: unknown): string =>
  String(value).replace(/\s+/g, " ").trim().slice(0, 500)

const errorIdentity = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error)
    return {
      name: boundedErrorText(error.name || "Error"),
      message: boundedErrorText(error.message || "no message"),
    }
  return { name: "UnknownError", message: boundedErrorText(error) }
}

export const reloadFailureDiagnostic = (
  request: ReloadCommandRequest,
  error: unknown,
): string => {
  const identity = errorIdentity(error)
  const abortSource =
    identity.name === "AbortError"
      ? "host did not expose signal.reason"
      : "not-an-abort"
  return [
    "Pi reload failed",
    "operation=ctx.reload",
    "phase=reload-runtime-command",
    `initiator=${request.initiator}`,
    `request=${request.requestId}`,
    "reload-succeeded=unknown (host threw before confirmation)",
    `error=${identity.name}: ${identity.message}`,
    `abort-source=${abortSource}`,
  ].join(" · ")
}
