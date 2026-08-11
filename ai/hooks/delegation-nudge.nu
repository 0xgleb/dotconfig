# Delegation wrist-slap: counts consecutive Edit/Write tool calls per session
# and injects a nudge into the model context on the 3rd one and every 3rd
# thereafter (3, 6, 9, ...), until an Agent delegation or a fresh user prompt
# resets the streak. Not every qualifying edit: a long judgment-bound streak
# would otherwise re-inject the identical ~600-character paragraph into
# context on every single call, burning the input tokens the nudge exists to
# conserve and training the model to skim past a message it has already seen
# a dozen times.
#
# Routing is done by the settings.json matchers, not here: this script only
# ever receives Edit|Write|MultiEdit|NotebookEdit events, Agent|Task events,
# or UserPromptSubmit events with no tool_name. Read/Bash calls in between
# never reach it, so an edit streak survives interleaved reads.
#
# The emitted {hookSpecificOutput: {hookEventName, additionalContext}} shape
# is documented for PostToolUse in Claude Code's hooks reference (see the
# "Hook Output" table's PostToolUse row), matching the PostToolUse-only
# matchers this hook is wired to in claude.settings.json.
def main [] {
    let payload = $in | from json
    let session = $payload.session_id? | default "unknown" | str replace --all --regex '[^a-zA-Z0-9-]' ''
    let tool = $payload.tool_name? | default ""
    let state = $"/tmp/claude-delegation-streak-($session)"
    if $tool in ["Edit" "Write" "MultiEdit" "NotebookEdit"] {
        let n = (try { open --raw $state | str trim | into int } catch { 0 }) + 1
        $"($n)" | save --force $state
        if $n >= 3 and ($n mod 3) == 0 {
            let msg = $"Delegation check - hook: this is inline edit #($n) in a row with no subagent delegation. Owner policy 2026-08-03, weekly usage budget critical: Fable plans, delegates, and verifies - mechanical or multi-file execution goes to Sonnet 5 / Opus 5 subagents via the Agent tool. If the remaining work in this stretch is well-specified, stop editing inline and delegate it now; continue inline only for genuinely judgment-bound single-file changes. Subagents: ignore this nudge."
            {hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $msg}} | to json -r
        }
    } else {
        rm --force $state
    }
}
