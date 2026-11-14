import { Schema } from "effect"

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

const OwnerInterventionQuerySchema = Schema.Struct({
  report: Schema.declare<OwnerInterventionQuery["report"]>(
    (value): value is OwnerInterventionQuery["report"] =>
      typeof value === "function",
  ),
})

const OwnerInterventionRelaySchema = Schema.Struct({
  targetAgentId: Schema.String,
  targetCwd: Schema.String,
  ownerInteractionAt: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})

export const decodeOwnerInterventionQuery = Schema.decodeUnknownEither(
  OwnerInterventionQuerySchema,
  { onExcessProperty: "ignore" },
)

export const decodeOwnerInterventionRelay = Schema.decodeUnknownEither(
  OwnerInterventionRelaySchema,
  { onExcessProperty: "ignore" },
)
