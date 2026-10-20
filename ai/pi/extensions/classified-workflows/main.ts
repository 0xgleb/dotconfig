import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import remoteControl from "../remote-control/index.ts"
import questions, { type QuestionDeliveryStatus } from "../questions/index.ts"
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
    )
  })
}
