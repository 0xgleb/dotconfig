import {
  createEditTool,
  createReadTool,
  getLanguageFromPath,
  highlightCode,
  type EditToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import * as Effect from "effect/Effect"

import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { executeWithContextCwd } from "./contextual-tool.ts"
import { readResultPresentation, type ReadOutput } from "./presentation.ts"
import { highlightFileContent, highlightUnifiedDiff } from "./rendering.ts"

const diffCounts = (diff: string): { readonly additions: number; readonly removals: number } =>
  diff.split("\n").reduce(
    (counts, line) => ({
      additions: counts.additions + (line.startsWith("+") && !line.startsWith("+++") ? 1 : 0),
      removals: counts.removals + (line.startsWith("-") && !line.startsWith("---") ? 1 : 0),
    }),
    { additions: 0, removals: 0 },
  )

export default function compactRead(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "compact-read", "2026.07.31.1")
  const originalRead = createReadTool(process.cwd())
  const originalEdit = createEditTool(process.cwd())

  pi.registerTool({
    name: "read",
    label: "read",
    description: originalRead.description,
    parameters: originalRead.parameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeWithContextCwd(ctx.cwd, createReadTool, [toolCallId, params, signal, onUpdate])
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("read "))
      text += theme.fg("accent", args.path)
      if (args.offset || args.limit) {
        const ranges = [
          args.offset ? `offset=${args.offset}` : undefined,
          args.limit ? `limit=${args.limit}` : undefined,
        ].filter((range): range is string => range !== undefined)
        text += theme.fg("dim", ` (${ranges.join(", ")})`)
      }
      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const content = result.content[0]
      const output: ReadOutput =
        content?.type === "text"
          ? { kind: "text", text: content.text }
          : content?.type === "image"
            ? { kind: "image" }
            : { kind: "missing" }
      const mode = isPartial ? "partial" : expanded ? "expanded" : "collapsed"
      const presentation = readResultPresentation(output, mode).pipe(
        Effect.match({
          onFailure: ({ message }) => theme.fg("error", message),
          onSuccess: text =>
            expanded && output.kind === "text"
              ? highlightFileContent(context.args.path, text, getLanguageFromPath, highlightCode)
              : theme.fg("success", text),
        }),
      )
      return new Text(Effect.runSync(presentation), 0, 0)
    },
  })

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: originalEdit.description,
    parameters: originalEdit.parameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeWithContextCwd(ctx.cwd, createEditTool, [toolCallId, params, signal, onUpdate])
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", args.path),
        0,
        0,
      )
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0)
      const content = result.content[0]
      if (content?.type === "text" && content.text.startsWith("Error")) {
        return new Text(theme.fg("error", content.text.split("\n")[0] ?? "Edit failed"), 0, 0)
      }
      const details = result.details as EditToolDetails | undefined
      if (!details?.diff) return new Text(theme.fg("success", "Applied"), 0, 0)
      const counts = diffCounts(details.diff)
      if (!expanded) {
        return new Text(
          `${theme.fg("toolDiffAdded", `+${counts.additions}`)} ${theme.fg("dim", "/")} ${theme.fg("toolDiffRemoved", `-${counts.removals}`)}`,
          0,
          0,
        )
      }
      return new Text(
        highlightUnifiedDiff(
          context.args.path,
          details.diff,
          theme,
          getLanguageFromPath,
          highlightCode,
        ),
        0,
        0,
      )
    },
  })
}
