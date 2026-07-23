export const REGISTRY_INTENT_REQUEST_EVENT = "pi:registry-intent-request";
export type RegistryIntentReporter = (intent: string) => void;

export interface RegistryIntentRequest {
  readonly agentId: string;
  readonly report: RegistryIntentReporter;
}
