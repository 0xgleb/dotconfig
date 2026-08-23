export const ACTIVITY_PHASE_EVENT = "pi:activity-phase";

export interface ClassifierActivityEvent {
  readonly active: boolean;
  readonly boundary: "action" | "tool-result" | "spawn" | "return";
  readonly subject: string;
}
