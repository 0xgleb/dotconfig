import { channel } from "node:diagnostics_channel"
import { homedir } from "node:os"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import {
  installRequestLifecycleLogging,
  requestLifecycleLogPath,
} from "./core.ts"

const logPath = requestLifecycleLogPath(
  process.env.XDG_STATE_HOME,
  homedir(),
  process.pid,
)

export default function requestObservabilityExtension(pi: ExtensionAPI) {
  const lifecycleChannel = channel("pi.request.lifecycle")
  const uninstall = installRequestLifecycleLogging(lifecycleChannel, logPath)

  pi.registerCommand("request-log", {
    description: "Show this Pi process's structured request lifecycle log",
    handler: async (_args, ctx) => {
      ctx.ui.notify(logPath, "info")
    },
  })

  pi.on("session_shutdown", () => uninstall())
}
