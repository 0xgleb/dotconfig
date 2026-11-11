import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { validateToolArguments } from "@earendil-works/pi-ai"
import { visibleWidth } from "@earendil-works/pi-tui"
import * as tools from "../tool.ts"
import * as native from "../native.ts"

const exposeTestHost = (pi: ExtensionAPI): void => {
  pi.events.emit("issue-task-test-host", {
    version: VERSION,
    validateToolArguments,
    visibleWidth,
    tools,
    native,
  })
}

export default exposeTestHost
