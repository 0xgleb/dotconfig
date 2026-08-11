export const REGISTRY_INTENT_REQUEST_EVENT = "pi:registry-intent-request"
export const REGISTRY_IDENTITY_REQUEST_EVENT = "pi:registry-identity-request"
export const MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT =
  "pi:managed-operational-role-resumed"
export type RegistryIntentReporter = (intent: string) => void

export interface RegistryIntentRequest {
  readonly agentId: string
  readonly report: RegistryIntentReporter
}

export interface RegistryRoleIdentity {
  readonly role: string
  readonly mode: "task" | "operational"
}

export interface RegistryIdentityRequest {
  readonly agentId: string
  readonly report: (identity: RegistryRoleIdentity) => void
}

export interface ManagedOperationalRoleResumed {
  readonly project: string
  readonly role: string
}

export const REGISTRY_DELEGATE_REQUEST_EVENT = "pi:registry-delegate-request"

export type RegistryDelegateOutcome =
  | { readonly outcome: "queued"; readonly requestId: string }
  | { readonly outcome: "failed"; readonly reason: string }

/**
 * Mechanical delegate lane used by the dispatch flow: the emitter provides
 * the raw message and target project, the agent-registry extension performs
 * the typed enqueue with no model or classifier involvement, and reports the
 * queued request id (or a bounded failure) through the callback.
 */
export interface RegistryDelegateRequest {
  readonly project: string
  readonly role: string
  readonly text: string
  readonly requesterId: string
  readonly requesterLabel: string
  readonly requesterCwd: string
  /**
   * Bridge agent this request is being routed to, when the roster named a
   * receiver for the target project. Recording it on the row is what lets that
   * receiver close the request with an outcome envelope later, since a lane
   * outside Pi holds no registry lease. It is a bridge agent id and is never
   * compared against a registry session id.
   */
  readonly assignedAgentId?: string
  readonly report: (outcome: RegistryDelegateOutcome) => void
}

export const REGISTRY_PROJECTS_REQUEST_EVENT = "pi:registry-projects-request"

/**
 * Roster lane for routing: the registry reports every distinct absolute
 * project path it knows about, including projects whose receiver holds no
 * live lease right now, so routing can address an agent between polls.
 */
export interface RegistryProjectsRequest {
  readonly report: (projects: readonly string[]) => void
}

export const REGISTRY_OUTCOME_EVENT = "pi:registry-outcome-request"

export type RegistryOutcomeResult =
  | { readonly outcome: "recorded" }
  | { readonly outcome: "failed"; readonly reason: string }

/**
 * Mechanical completion lane for receiver outcome envelopes: the dispatch flow
 * parses the envelope and names the bridge sender that carried it, and the
 * agent-registry extension records the reported outcome against the request
 * with no model or classifier involvement, then reports through the callback.
 *
 * Entitlement is a property of the row: the request is closed by the agent it
 * was routed to, or by the session holding its project role lease. The lane
 * relaying the envelope takes no lease of its own and closes nothing on its own
 * identity.
 */
export interface RegistryOutcomeRequest {
  readonly requestId: string
  readonly resolution: "completed" | "failed"
  readonly summary: string
  /**
   * Who is reporting the outcome, taken from the bridge message that carried
   * the envelope. Completing a delegated request is a privileged act, and
   * without a sender any bridge actor can close work it was never given -
   * including work another session is midway through. Undefined means the
   * envelope arrived with no attributable sender and is not entitled to
   * complete anything.
   */
  readonly senderId: string | undefined
  readonly report: (result: RegistryOutcomeResult) => void
}
