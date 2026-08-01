export const REGISTRY_INTENT_REQUEST_EVENT = "pi:registry-intent-request"
export const MANAGED_OPERATIONAL_ROLE_RESUMED_EVENT =
  "pi:managed-operational-role-resumed"
export type RegistryIntentReporter = (intent: string) => void

export interface RegistryIntentRequest {
  readonly agentId: string
  readonly report: RegistryIntentReporter
}

export interface ManagedOperationalRoleResumed {
  readonly project: string
  readonly role: string
}
