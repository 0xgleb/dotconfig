import { Effect } from "effect"
import type {
  RegistryDelegateOutcome,
  RegistryDelegateRequest,
} from "../shared/registry-intent-events.ts"
import type { RegistryError, RegistryStore } from "./registry.ts"

const MAX_DELEGATED_PROJECT = 512
const MAX_DELEGATED_ROLE = 64
const MAX_DELEGATED_TEXT = 16_000
const MAX_ASSIGNED_AGENT_ID = 128

/**
 * Why a delegate payload cannot be queued, or undefined when it can.
 *
 * The payload carries an owner message routed by another lane, so an over-long
 * body or a relative project path is an ordinary arrival rather than a
 * programming fault. Naming the violated field is what lets the emitter tell
 * its sender the routing failed instead of losing the message in silence.
 */
export const delegateRejection: (
  payload: RegistryDelegateRequest,
) => string | undefined = (payload) => {
  if (
    typeof payload.project !== "string" ||
    !payload.project.startsWith("/") ||
    payload.project.length > MAX_DELEGATED_PROJECT
  )
    return `project must be an absolute path of at most ${MAX_DELEGATED_PROJECT} characters`
  if (
    typeof payload.role !== "string" ||
    payload.role.length === 0 ||
    payload.role.length > MAX_DELEGATED_ROLE
  )
    return `role must contain 1-${MAX_DELEGATED_ROLE} characters`
  if (
    typeof payload.text !== "string" ||
    payload.text.length === 0 ||
    payload.text.length > MAX_DELEGATED_TEXT
  )
    return `request text must contain 1-${MAX_DELEGATED_TEXT} characters`
  if (
    typeof payload.requesterId !== "string" ||
    typeof payload.requesterLabel !== "string" ||
    typeof payload.requesterCwd !== "string"
  )
    return "requester identity must name an id, a label, and a working directory"
  if (
    payload.assignedAgentId !== undefined &&
    (typeof payload.assignedAgentId !== "string" ||
      payload.assignedAgentId.length === 0 ||
      payload.assignedAgentId.length > MAX_ASSIGNED_AGENT_ID)
  )
    return `assigned agent id must contain 1-${MAX_ASSIGNED_AGENT_ID} characters`
  return undefined
}

/**
 * Queue one routed message against the project role that will run it.
 *
 * This lane only ever enqueues. Routing a message decides who should do the
 * work, not that it has been picked up: the receiver claims through its own
 * lease, or reports over the bridge as the agent the row was assigned to.
 * Recording that assignment is the whole reason the enqueue carries it - it is
 * what later entitles a receiver holding no registry lease to close the row.
 */
export const enqueueDelegatedRequest: (
  store: RegistryStore,
  payload: RegistryDelegateRequest,
  now: number,
) => Effect.Effect<RegistryDelegateOutcome, RegistryError> = (
  store,
  payload,
  now,
) => {
  const rejection = delegateRejection(payload)
  if (rejection)
    return Effect.succeed<RegistryDelegateOutcome>({
      outcome: "failed",
      reason: rejection,
    })
  return Effect.map(
    store.enqueue({
      project: payload.project,
      role: payload.role,
      requesterId: payload.requesterId,
      requesterLabel: payload.requesterLabel,
      requesterCwd: payload.requesterCwd,
      ...(payload.assignedAgentId
        ? { assignedAgentId: payload.assignedAgentId }
        : {}),
      text: payload.text,
      now,
    }),
    (queued): RegistryDelegateOutcome => ({
      outcome: "queued",
      requestId: queued.id,
    }),
  )
}
