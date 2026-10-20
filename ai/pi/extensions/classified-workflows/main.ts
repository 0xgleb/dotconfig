import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import remoteControl from "../remote-control/index.ts"
import questions, {
  type QuestionDeliveryStatus,
  type QuestionRefreshResult,
} from "../questions/index.ts"
import { editOwnerQuestionRelay } from "../remote-control/owner-telegram.ts"
import { questionCardHtml } from "../remote-control/question-card.ts"
import { identifiedAgentLabel } from "../remote-control/agent-identity.ts"
import { homedir } from "node:os"
import { Effect, Either } from "effect"
import { makeRemoteBridgeStore } from "../remote-control/sqlite-store.ts"
import { remoteBridgeDatabasePath } from "../remote-control/paths.ts"
import classifiedWorkflows from "./index.ts"
import { runContentProcess } from "../shared/content-process.ts"

/** A private capability connects verified owner ingress to the execution guard. */
export default (pi: ExtensionAPI): void => {
  classifiedWorkflows(pi, guard => {
    remoteControl(
      pi,
      guard.timing === "legacy-input"
        ? receivedAt => {
            guard.ownerInput(receivedAt)
          }
        : undefined,
      {
        ...(guard.inputDelivery
          ? { authorizeOwnerInput: guard.inputDelivery.authorizeInput }
          : {}),
        reporting: {
          execution: Object.freeze({ admit: guard.admit, track: guard.track }),
          process: runContentProcess,
        },
      },
    )
    const questionStore = makeRemoteBridgeStore(
      remoteBridgeDatabasePath(process.env.XDG_STATE_HOME, homedir()),
    )
    questions(
      pi,
      Object.freeze({ admit: guard.admit, track: guard.track }),
      async (ids, ctx): Promise<readonly QuestionDeliveryStatus[]> => {
        const agentId = ctx.sessionManager.getSessionId()
        return Effect.runPromise(
          Effect.forEach(ids, id =>
            questionStore.isQuestionRelayed({ agentId, questionId: id }).pipe(
              Effect.either,
              Effect.map(result => ({
                id,
                status: Either.isLeft(result)
                  ? ("unavailable" as const)
                  : result.right
                    ? ("telegram-delivered" as const)
                    : ("not-confirmed" as const),
              })),
            ),
          ),
        )
      },
      async (id, ctx, signal): Promise<QuestionRefreshResult> => {
        const agentId = ctx.sessionManager.getSessionId()
        const loaded = await Effect.runPromise(
          Effect.either(
            Effect.all({
              binding: questionStore.getTelegramQuestionBinding({
                agentId,
                questionId: id,
              }),
              agents: questionStore.listAgents(Date.now()),
            }),
          ),
        )
        if (Either.isLeft(loaded))
          return { outcome: "unavailable", id, reason: loaded.left.message }
        const agent = loaded.right.agents.find(agent => agent.id === agentId)
        const admission = guard.admit()
        if (
          !agent ||
          Either.isLeft(admission) ||
          signal?.aborted ||
          ctx.sessionManager.getSessionId() !== agentId
        )
          return {
            outcome: "unavailable",
            id,
            reason:
              "Question refresh authority or session is no longer current.",
          }
        const { binding, agents } = loaded.right
        const edited = await Effect.runPromise(
          Effect.either(
            editOwnerQuestionRelay(
              {
                chatId: binding.chatId,
                messageId: binding.messageId,
                text: questionCardHtml(
                  binding.question,
                  identifiedAgentLabel(agent, agents),
                ),
              },
              signal,
            ),
          ),
        )
        return Either.isLeft(edited)
          ? {
              outcome: "unavailable",
              id,
              reason: edited.left.message,
              ...(edited.left.code === "refresh_not_modified"
                ? { reasonKind: "already-current" as const }
                : {}),
            }
          : { outcome: "updated", id, ...edited.right }
      },
    )
  })
}
