import { StringEnum } from "@earendil-works/pi-ai"
import {
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Effect } from "effect"
import { Type } from "typebox"

import { LanguageClientPool } from "./client.ts"
import {
  createLspCore,
  LspCoreError,
  type LspResultDetails,
  type LspToolInput,
} from "./core.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"

const parameters = Type.Object(
  {
    action: StringEnum([
      "status",
      "definition",
      "references",
      "diagnostics",
      "rename_preview",
      "code_actions",
      "code_action_preview",
      "apply",
    ] as const),
    file: Type.Optional(
      Type.String({
        description: "File path relative to the current workspace",
        maxLength: 1_024,
      }),
    ),
    line: Type.Optional(
      Type.Integer({
        description: "One-based source line for position actions",
        minimum: 1,
      }),
    ),
    symbol: Type.Optional(
      Type.String({
        description: "Exact symbol text on line",
        minLength: 1,
        maxLength: 256,
      }),
    ),
    occurrence: Type.Optional(
      Type.Integer({
        description: "One-based occurrence of symbol on line",
        minimum: 1,
        maximum: 100,
      }),
    ),
    newName: Type.Optional(
      Type.String({
        description: "New symbol name for rename_preview",
        minLength: 1,
        maxLength: 256,
      }),
    ),
    selector: Type.Optional(
      Type.Integer({
        description: "Zero-based code-action index from code_actions",
        minimum: 0,
        maximum: 99,
      }),
    ),
    previewId: Type.Optional(
      Type.String({
        description:
          "Exact digest-bound preview ID returned by a preview action",
        minLength: 1,
        maxLength: 96,
      }),
    ),
  },
  { additionalProperties: false },
)

const renderSummary = (details: LspResultDetails | undefined): string => {
  if (!details) return "LSP completed"
  if (details.rejection)
    return `Rename preview unavailable · ${details.rejection.message}`
  if (details.preview)
    return `${details.preview.kind === "rename" ? "Rename" : "Code action"} preview · ${details.preview.editCount} edit(s) · ${details.preview.files.length} file(s)`
  if (details.applied)
    return `Applied preview · ${details.applied.files.length} file(s)`
  if (details.locations)
    return `${details.locations.length} ${details.action}(s)${details.omitted ? ` · ${details.omitted} omitted` : ""}`
  if (details.diagnostics)
    return details.diagnostics.length === 0
      ? "No diagnostics"
      : `${details.diagnostics.length} diagnostic(s)${details.omitted ? ` · ${details.omitted} omitted` : ""}`
  if (details.actions)
    return `${details.actions.length} code action(s)${details.omitted ? ` · ${details.omitted} omitted` : ""}`
  if (details.status)
    return `${details.status.length} managed server profile(s)`
  return "LSP completed"
}

export default function lspExtension(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "lsp", "2026.09.04.1")
  const clients = new LanguageClientPool()
  const core = createLspCore({
    clients,
    workspaceEditIo: {
      withMutationQueue: (path, work) => withFileMutationQueue(path, work),
    },
  })

  pi.on("session_shutdown", async () => {
    core.clearPreviews()
    await clients.dispose()
  })

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description:
      "Query managed language servers for definition, references, diagnostics, safe rename previews, and edit-only code actions. Mutations require a separate digest-bound apply call.",
    promptSnippet:
      "Use typed language-server navigation and preview-first refactors",
    promptGuidelines: [
      "Use lsp definition and references instead of text search when changing an exported symbol.",
      "Use lsp rename_preview or code_action_preview, inspect the returned files, then call lsp apply with the exact previewId; never manually reproduce a valid LSP rename.",
      "Use lsp diagnostics after a source change when a managed language server is available; an unavailable server is not permission to invent a clean result.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted()
      const result = await Effect.runPromise(
        core.execute(params as LspToolInput, ctx.cwd, signal),
        { signal },
      )
      signal?.throwIfAborted()
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: result.details,
      }
    },
    renderCall(args, theme) {
      const target = typeof args.file === "string" ? ` · ${args.file}` : ""
      return new Text(
        `${theme.fg("toolTitle", theme.bold("LSP"))} ${theme.fg("accent", args.action)}${theme.fg("dim", target)}`,
        0,
        0,
      )
    },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as LspResultDetails | undefined
      const content = result.content.find(item => item.type === "text")
      const text = content?.type === "text" ? content.text : ""
      if (context.isError)
        return new Text(theme.fg("error", text || "LSP failed"), 0, 0)
      if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0)
      return new Text(theme.fg("muted", renderSummary(details)), 0, 0)
    },
  })
}

export { LspCoreError }
