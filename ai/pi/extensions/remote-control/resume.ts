import { Effect } from "effect"
import { TELEGRAM_RESUME_REQUEST } from "../shared/telegram-resume.ts"
import {
  BRIDGE_MESSAGE_TTL_MS,
  type BridgeAgent,
  type RemoteMessage,
  type RemoteBridgeError,
} from "./protocol.ts"
import type { RemoteBridgeStore } from "./sqlite-store.ts"

export type ResumeWorkerOutcome =
  | {
      readonly status: "accepted"
      readonly agent: BridgeAgent
      readonly message: RemoteMessage
    }
  | {
      readonly status: "skipped"
      readonly agent: BridgeAgent
      readonly reason: string
    }

export const resumeWorkers = (
  store: Pick<RemoteBridgeStore, "listAgents" | "enqueue">,
  input: {
    readonly requesterId: "owner-pane" | `telegram-owner-${number}`
    readonly invocationId: string
  },
): Effect.Effect<readonly ResumeWorkerOutcome[], RemoteBridgeError> =>
  store.listAgents(Date.now(), { includeExpired: true }).pipe(
    Effect.flatMap(agents =>
      Effect.forEach(
        agents.filter(agent => !agent.nativeManager),
        (agent): Effect.Effect<ResumeWorkerOutcome> => {
          if (
            agent.workDelivery !== "native-pi" ||
            agent.expiresAt <= Date.now()
          )
            return Effect.succeed({
              status: "skipped",
              agent,
              reason: "offline or unavailable",
            })
          return store
            .enqueue({
              targetAgentId: agent.id,
              requesterId: input.requesterId,
              dedupeKey: `resume-${input.invocationId}-${agent.id}`,
              text: TELEGRAM_RESUME_REQUEST,
              now: Date.now(),
              ttlMs: BRIDGE_MESSAGE_TTL_MS,
            })
            .pipe(
              Effect.map((message): ResumeWorkerOutcome =>
                message.status === "failed"
                  ? { status: "skipped", agent, reason: message.failure }
                  : { status: "accepted", agent, message },
              ),
              Effect.catchAll(error =>
                Effect.succeed({
                  status: "skipped" as const,
                  agent,
                  reason: error.code,
                }),
              ),
            )
        },
        { concurrency: 4 },
      ),
    ),
  )

export const resumeOutcomeText = (
  results: readonly ResumeWorkerOutcome[],
): string =>
  [
    ...results.map(result => {
      const identity = `${result.agent.label} · ${result.agent.cwd} · session ${result.agent.id}`
      if (result.status === "skipped")
        return `Skipped (${result.reason}): ${identity}`
      const status =
        result.message.status === "completed"
          ? "Input already accepted"
          : result.message.status === "claimed"
            ? "Delivering"
            : "Queued"
      return `${status}: ${identity}`
    }),
    ...(results.length === 0 ? ["No worker sessions are registered."] : []),
    "Expired or missing sessions are not restarted.",
  ].join("\n")
