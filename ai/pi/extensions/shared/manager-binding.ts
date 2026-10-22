import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Data, Either } from "effect"

export type ManagerBinding =
  | { readonly role: "worker" }
  | { readonly role: "manager"; readonly workerSessionId: string }

export class ManagerBindingError extends Data.TaggedError(
  "ManagerBindingError",
)<{
  readonly message: string
}> {}

export const getManagerBinding = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Either.Either<ManagerBinding, ManagerBindingError> => {
  let answer: ManagerBinding | undefined
  let invalid = false
  const emitted = Either.try({
    try: () =>
      pi.events.emit(BINDING_EVENT, {
        version: 1,
        sessionId: ctx.sessionManager.getSessionId(),
        accept: (value: ManagerBinding) => {
          if (!validBinding(value)) {
            invalid = true
            return
          }
          if (answer && JSON.stringify(answer) !== JSON.stringify(value)) {
            invalid = true
            return
          }
          answer = value
        },
      } satisfies BindingQuery),
    catch: () =>
      new ManagerBindingError({
        message: "Manager session binding could not be verified.",
      }),
  })
  if (Either.isLeft(emitted)) return Either.left(emitted.left)
  if (invalid)
    return Either.left(
      new ManagerBindingError({
        message: "Conflicting or malformed manager session bindings.",
      }),
    )
  const marked = ctx.sessionManager
    .getBranch()
    .some(
      entry =>
        entry.type === "message" &&
        entry.message.role === "custom" &&
        entry.message.customType === "manager-worker-observation",
    )
  if (marked && answer?.role !== "manager")
    return Either.left(
      new ManagerBindingError({
        message:
          "Manager binding is unavailable; refusing to use a separate local backlog.",
      }),
    )
  return Either.right(answer ?? { role: "worker" })
}

export const registerManagerBinding = (
  pi: ExtensionAPI,
  resolve: (sessionId: string) => ManagerBinding | undefined,
): (() => void) =>
  pi.events.on(BINDING_EVENT, value => {
    if (!query(value)) return
    const binding = resolve(value.sessionId)
    if (binding !== undefined) value.accept(binding)
  })

interface BindingQuery {
  readonly version: 1
  readonly sessionId: string
  readonly accept: (value: ManagerBinding) => void
}

const BINDING_EVENT = "pi:manager-session-binding.v1"
const validBinding = (value: unknown): value is ManagerBinding =>
  typeof value === "object" &&
  value !== null &&
  "role" in value &&
  (value.role === "worker" ||
    (value.role === "manager" &&
      "workerSessionId" in value &&
      typeof value.workerSessionId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value.workerSessionId)))

const query = (value: unknown): value is BindingQuery =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  value.version === 1 &&
  "sessionId" in value &&
  typeof value.sessionId === "string" &&
  "accept" in value &&
  typeof value.accept === "function"
