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
 * Mechanical completion lane for receiver outcome envelopes: the dispatch
 * flow parses the envelope, the agent-registry extension performs the typed
 * claim and completion (or failure) under its own lease with no model or
 * classifier involvement, and reports through the callback.
 */
export interface RegistryOutcomeRequest {
  readonly requestId: string
  readonly resolution: "completed" | "failed"
  readonly summary: string
  readonly report: (result: RegistryOutcomeResult) => void
}
