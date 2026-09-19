# Conversational voice

Voice uses the unmodified [pi-live-codex](https://github.com/brettinternet/pi-extensions#live-codex)
package, pinned to **0.1.7** in `ai/pi.settings.json`.

## Use

1. In an interactive Pi session, run `/live` (default voice: `sol`).
2. Allow microphone access if macOS asks, then talk normally. Capture continues
   between turns; no push-to-talk key is required. Spoken replies and interruptions
   are supported. Headphones can reduce speaker-to-microphone feedback.
3. Press **Esc** to stop and restore the normal editor and its draft.

With an empty live editor, **Space** mutes/resumes. Typing in live mode stages a
note for the voice conversation rather than behaving like the normal Pi prompt.
No existing keybindings are remapped. Pi may warn that the package's optional
Ctrl+L shortcut conflicts with model selection; use `/live` to start. The live
visualizer also defines Ctrl+L as stop, so do not depend on it for model selection
while voice is active.

Coding requests go back through the current Pi agent. Existing authorization and
question workflows still apply; installing voice does not grant new tool authority
or automatically resolve question cards.

## Setup and verification

Install the exact package through Pi, then reload Pi resources:

```text
pi install npm:pi-live-codex@0.1.7
```

The package requires Node 22.19 or newer and its platform-native audio bindings.
It uses the existing OpenAI Codex login when voice is explicitly started; if Pi
reports that login is missing, use `/login openai-codex`. Do not inspect or copy
credential files.

This is an experimental Codex live protocol, not a guarantee of account access.
A successful package/native load does not verify service entitlement, signaling,
macOS permissions, audio devices, or conversational quality. Test those manually
with a short conversation and a spoken follow-up before relying on the setup.
Voice does not start automatically when the package loads.
