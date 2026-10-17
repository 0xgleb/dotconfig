import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import remoteControl from "../remote-control/index.ts"
import classifiedWorkflows from "./index.ts"

/** A private capability connects verified owner ingress to the execution guard. */
export default (pi: ExtensionAPI): void => {
  classifiedWorkflows(pi, guard => {
    remoteControl(pi, receivedAt => {
      guard.ownerInput(receivedAt)
    })
  })
}
