import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import remoteControl from "../remote-control/index.ts"
import questions from "../questions/index.ts"
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
    questions(pi, Object.freeze({ admit: guard.admit, track: guard.track }))
  })
}
