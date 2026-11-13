import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { registryStateRoot } from "../agent-registry/paths.ts"
import { registerNativeTaskHost } from "./host.ts"
import { nativeTaskRuntimeOptions } from "./runtime.ts"

const issueTaskExtension = (pi: ExtensionAPI): void => {
  const databasePath = join(
    registryStateRoot(process.env.XDG_STATE_HOME, homedir()),
    "registry.sqlite",
  )

  registerNativeTaskHost(
    pi,
    nativeTaskRuntimeOptions(databasePath, report =>
      Effect.sync(() => {
        pi.sendMessage(
          {
            customType: "task-host-failure",
            content: `Task host ${report.phase} failed (${report.code}).`,
            details: report,
            display: true,
          },
          { triggerTurn: false },
        )
      }),
    ),
  )
}

export default issueTaskExtension
