export const HUMAN_TURN_EVENT = "usage-governor:human-turn"
export const RESPONSIVE_AUTONOMOUS_TURN_EVENT =
  "usage-governor:responsive-autonomous-turn"

export const OWNER_INTERVENTION_QUERY_EVENT =
  "usage-governor:owner-intervention-query"
export const OWNER_INTERVENTION_RELAY_EVENT =
  "usage-governor:owner-intervention-relay"

export interface OwnerInterventionQuery {
  readonly report: (ownerInteractionAt: number | undefined) => void
}

export interface OwnerInterventionRelay {
  readonly targetAgentId: string
  readonly targetCwd: string
  readonly ownerInteractionAt: number
}
