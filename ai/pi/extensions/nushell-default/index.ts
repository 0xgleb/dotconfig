import {
  createBashToolDefinition,
  type BashToolInput,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent"
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui"
import { Effect, Either } from "effect"

import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import {
  nushellTableWidthPrefix,
  nushellToolPreviewLines,
  resolveNushellPath,
  resolveNushellTableWidth,
} from "./core.ts"
import {
  applyDirenvEnvironment,
  createDirenvEnvironmentLoader,
  resolveDirenvPath,
  runDirenvExportProcess,
} from "./direnv.ts"

let latestNushellTuiWidth: number | undefined

export const nushellPromptGuidelines = [
  "The bash tool name is retained only for API compatibility; its command text is parsed directly by Nushell, not Bash.",
  "Write native Nushell commands. Put sequential statements on literal newlines instead of separating them with semicolons, and keep each line concise for the current terminal width.",
] as const

export const renderNushellCall = (
  args: BashToolInput,
  theme: Theme,
): Component => {
  const command =
    typeof args.command === "string" && args.command.length > 0
      ? args.command
      : "..."

  return {
    render: width => {
      latestNushellTuiWidth = width
      const preview = nushellToolPreviewLines(
        command,
        args.timeout,
        width,
        wrapTextWithAnsi,
      )
      return [
        ...preview.commandLines.map(line =>
          theme.fg("toolTitle", theme.bold(line)),
        ),
        ...preview.timeoutLines.map(line => theme.fg("muted", line)),
      ]
    },
    invalidate: () => undefined,
  }
}

export default function nushellDefault(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "nushell-default", "2026.09.04.1")
  const shellPathResult = Effect.runSync(
    Effect.either(resolveNushellPath(process.env.HOME)),
  )
  if (Either.isLeft(shellPathResult)) {
    process.stderr.write(`[nushell-default] ${shellPathResult.left.message}\n`)
    return
  }
  const shellPath = shellPathResult.right
  const direnvPathResult = Effect.runSync(
    Effect.either(resolveDirenvPath(process.env.HOME)),
  )
  if (Either.isLeft(direnvPathResult)) {
    process.stderr.write(`[nushell-default] ${direnvPathResult.left.message}\n`)
    return
  }
  const direnvLoader = createDirenvEnvironmentLoader({
    direnvPath: direnvPathResult.right,
    runExport: runDirenvExportProcess,
  })
  const definition = createBashToolDefinition(process.cwd(), { shellPath })

  pi.registerTool({
    ...definition,
    description:
      "Execute a Nushell command in the current working directory. Returns stdout and stderr. Output is truncated to 2000 lines or 50KB (whichever is hit first).",
    promptSnippet:
      "Execute native Nushell commands in the current working directory",
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      ...nushellPromptGuidelines,
    ],

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const tableWidth = resolveNushellTableWidth(
        latestNushellTuiWidth,
        process.stdout.columns,
        process.stderr.columns,
      )
      const environment = await direnvLoader.load(
        { command: params.command, cwd: ctx.cwd, env: process.env },
        signal,
      )
      if (!environment.ok)
        return {
          content: [
            {
              type: "text" as const,
              text: signal?.aborted ? "Command aborted" : environment.reason,
            },
          ],
          isError: true,
          details: {
            outcome: signal?.aborted ? "cancelled" : "environment-error",
          },
        }
      const exported = environment.exported
      return createBashToolDefinition(ctx.cwd, {
        shellPath,
        commandPrefix: nushellTableWidthPrefix(tableWidth),
        ...(exported
          ? {
              spawnHook: context => applyDirenvEnvironment(context, exported),
            }
          : {}),
      }).execute(toolCallId, params, signal, onUpdate, ctx)
    },

    renderCall: renderNushellCall,
  })
}
