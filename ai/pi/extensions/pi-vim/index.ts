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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import { VimEditor } from "./vim-editor.ts";

export default function (pi: ExtensionAPI) {
  registerRuntimeVersion(pi, "pi-vim", "2026.07.23.4");
  let wrapAutocomplete: ((provider: AutocompleteProvider) => AutocompleteProvider) | undefined;

  // Ack fzfp's editor check — registered at factory time so it's always ready.
  pi.events.on("pi-fzfp:check-editor", (ack: () => void) => { ack(); });

  // Capture the provider whenever fzfp announces it (emitted from both fzfp's
  // factory and its session_start to cover both load orderings).
  pi.events.on("pi-fzfp:provider", (fn: (provider: AutocompleteProvider) => AutocompleteProvider) => {
    wrapAutocomplete = fn;
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new VimEditor(tui, theme, keybindings, undefined, wrapAutocomplete, {
        isStreaming: () => !ctx.isIdle(),
        onImmediate: (text) => {
          if (ctx.isIdle()) {
            pi.sendUserMessage(text);
            return;
          }
          pi.sendUserMessage(text, { deliverAs: "followUp" });
          ctx.abort();
          ctx.ui.notify("Interrupted the current turn and delivered steering immediately.", "info");
        },
      })
    );
  });
}
