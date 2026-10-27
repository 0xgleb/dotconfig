import { Data, Either, Schema } from "effect"

export const AGENT_ROLES = [
  "manager",
  "driver-worker",
  "review-worker",
] as const

export type AgentRole = (typeof AGENT_ROLES)[number]

export class AgentRoleDecodeError extends Data.TaggedError(
  "AgentRoleDecodeError",
)<{
  readonly code: "invalid_agent_role"
  readonly message: string
}> {}

export const AgentRoleSchema = Schema.Literal(...AGENT_ROLES)

export const decodeAgentRole = (
  value: unknown,
): Either.Either<AgentRole, AgentRoleDecodeError> =>
  Either.mapLeft(
    decode(value),
    () =>
      new AgentRoleDecodeError({
        code: "invalid_agent_role",
        message: "Agent role must be manager, driver-worker, or review-worker.",
      }),
  )

const decode = Schema.decodeUnknownEither(AgentRoleSchema)
