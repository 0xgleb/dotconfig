/**
 * pi-vim: Vim motions extension for pi-coding-agent.
 * Replaces the default input editor with a vim-modal editor.
 *
 * Integrates with @burneikis/pi-fzfp if it is also installed:
 * - Responds to "pi-fzfp:check-editor" so fzfp skips its own setEditorComponent.
 * - Receives wrapWithFuzzyFiles via "pi-fzfp:provider" and passes it to VimEditor.
 *
 * Both listeners are registered during the factory (before session_start), so
 * they are in place regardless of which extension's session_start fires first.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { AutocompleteProvider } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { fallbackImageCaptions } from "../image-summary/core.ts"
import { generatedImageCaptions } from "../image-summary/index.ts"
import { parseTemporaryScreenshot } from "../input-ergonomics/core.ts"
import { loadTemporaryImage } from "../input-ergonomics/image.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { HUMAN_TURN_EVENT } from "../shared/usage-governor-events.ts"
import {
  getFocusedInputLatencySnapshot,
  installFocusedInputRenderCache,
  resetFocusedInputLatencySnapshot,
} from "./focused-input-render-cache.ts"
import { stableVimMode, type StableVimMode } from "./state.ts"
import { VimEditor } from "./vim-editor.ts"

const VIM_MODE_ENTRY = "pi-vim.mode"

type ProviderWrapper = (provider: AutocompleteProvider) => AutocompleteProvider

const isAcknowledgement = (value: unknown): value is () => void =>
  typeof value === "function"
const isProviderWrapper = (value: unknown): value is ProviderWrapper =>
  typeof value === "function"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const restoreVimMode = (entries: readonly unknown[]): StableVimMode => {
  let mode: StableVimMode = "insert"
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== VIM_MODE_ENTRY ||
      !isRecord(entry.data)
    )
      continue
    if (entry.data.mode === "insert" || entry.data.mode === "normal")
      mode = entry.data.mode
  }
  return mode
}

export default function (pi: ExtensionAPI) {
  registerRuntimeVersion(pi, "pi-vim", "2026.09.04.1")
  let wrapAutocomplete:
    ((provider: AutocompleteProvider) => AutocompleteProvider) | undefined
  let activeEditor: VimEditor | undefined
  let releaseFocusedInputRenderCache: (() => void) | undefined

  // Ack fzfp's editor check — registered at factory time so it's always ready.
  pi.events.on("pi-fzfp:check-editor", value => {
    if (isAcknowledgement(value)) value()
  })

  // Capture the provider whenever fzfp announces it (emitted from both fzfp's
  // factory and its session_start to cover both load orderings).
  pi.events.on("pi-fzfp:provider", value => {
    if (isProviderWrapper(value)) wrapAutocomplete = value
  })

  pi.registerTool({
    name: "typing_latency_probe",
    label: "Typing latency",
    description:
      "Read or reset bounded content-free timing samples from the current Pi editor input-to-terminal render path.",
    parameters: Type.Object({
      reset: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      if (params.reset) {
        resetFocusedInputLatencySnapshot()
        return {
          content: [{ type: "text", text: "Typing latency telemetry reset." }],
          details: getFocusedInputLatencySnapshot(),
        }
      }
      const snapshot = getFocusedInputLatencySnapshot()
      const recent = snapshot.samples.slice(-8)
      if (recent.length === 0)
        return {
          content: [
            {
              type: "text",
              text: "No typing latency samples have been recorded in this runtime.",
            },
          ],
          details: snapshot,
        }
      const average = (field: "totalMs" | "renderMs" | "residualRenderMs") =>
        recent.reduce((sum, sample) => sum + sample[field], 0) / recent.length
      const latest = recent.at(-1)!
      return {
        content: [
          {
            type: "text",
            text: [
              `Typing latency · ${snapshot.samples.length} bounded samples`,
              `recent avg total ${average("totalMs").toFixed(2)}ms · render ${average("renderMs").toFixed(2)}ms · residual ${average("residualRenderMs").toFixed(2)}ms`,
              `latest ${latest.totalMs.toFixed(2)}ms · ${latest.cacheStatus} · frame ${latest.previousFrameLines}→${latest.renderedLines} lines · terminal ${latest.terminalBytes} bytes`,
            ].join("\n"),
          },
        ],
        details: snapshot,
      }
    },
  })

  pi.on("session_start", (_event, ctx) => {
    const restoredMode = restoreVimMode(ctx.sessionManager.getBranch())
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new VimEditor(
        tui,
        theme,
        keybindings,
        undefined,
        wrapAutocomplete,
        {
          isStreaming: () => !ctx.isIdle(),
          initialMode: restoredMode,
          onAttachment: async attachment => {
            const screenshot = parseTemporaryScreenshot(attachment.path)
            if (!screenshot) return undefined
            const image = await loadTemporaryImage(screenshot)
            const generated = await generatedImageCaptions([image], ctx)
            return generated?.[0] ?? fallbackImageCaptions([image])[0]
          },
          onFollowUp: text => {
            pi.events.emit(HUMAN_TURN_EVENT, text)
            pi.sendUserMessage(text, { deliverAs: "followUp" })
          },
        },
      )
      releaseFocusedInputRenderCache?.()
      releaseFocusedInputRenderCache = installFocusedInputRenderCache(
        tui,
        editor,
      )
      activeEditor = editor
      return editor
    })
  })

  pi.on("session_shutdown", () => {
    releaseFocusedInputRenderCache?.()
    releaseFocusedInputRenderCache = undefined
    if (!activeEditor) return
    pi.appendEntry(VIM_MODE_ENTRY, {
      mode: stableVimMode(activeEditor.vimState.mode),
    })
    activeEditor = undefined
  })
}
