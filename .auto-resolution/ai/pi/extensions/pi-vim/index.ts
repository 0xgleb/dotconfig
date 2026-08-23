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
import { fallbackImageCaptions } from "../image-summary/core.ts"
import { generatedImageCaptions } from "../image-summary/index.ts"
import { parseTemporaryScreenshot } from "../input-ergonomics/core.ts"
import { loadTemporaryImage } from "../input-ergonomics/image.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { HUMAN_TURN_EVENT } from "../shared/usage-governor-events.ts"
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
  registerRuntimeVersion(pi, "pi-vim", "2026.08.14.4")
  let wrapAutocomplete:
    | ((provider: AutocompleteProvider) => AutocompleteProvider)
    | undefined
  let activeEditor: VimEditor | undefined

  // Ack fzfp's editor check — registered at factory time so it's always ready.
  pi.events.on("pi-fzfp:check-editor", value => {
    if (isAcknowledgement(value)) value()
  })

  // Capture the provider whenever fzfp announces it (emitted from both fzfp's
  // factory and its session_start to cover both load orderings).
  pi.events.on("pi-fzfp:provider", value => {
    if (isProviderWrapper(value)) wrapAutocomplete = value
  })

  pi.on("session_start", (_event, ctx) => {
    const restoredMode = restoreVimMode(ctx.sessionManager.getBranch())
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeEditor = new VimEditor(
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
      return activeEditor
    })
  })

  pi.on("session_shutdown", () => {
    if (!activeEditor) return
    pi.appendEntry(VIM_MODE_ENTRY, {
      mode: stableVimMode(activeEditor.vimState.mode),
    })
    activeEditor = undefined
  })
}
