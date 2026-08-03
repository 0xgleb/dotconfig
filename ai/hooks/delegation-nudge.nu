# Delegation wrist-slap: counts consecutive Edit/Write tool calls per session
# and injects a nudge into the model context every 5th one until an Agent
# delegation - or a fresh user prompt - resets the streak.
#
# Routing is done by the settings.json matchers, not here: this script only
# ever receives Edit|Write|MultiEdit|NotebookEdit events, Agent|Task events,
# or UserPromptSubmit events with no tool_name. Read/Bash calls in between
# never reach it, so an edit streak survives interleaved reads.
def main [] {
    let payload = ^cat | from json
    let session = $payload.session_id? | default "unknown" | str replace --all --regex '[^a-zA-Z0-9-]' ''
    let tool = $payload.tool_name? | default ""
    let state = $"/tmp/claude-delegation-streak-($session)"
    if $tool in ["Edit" "Write" "MultiEdit" "NotebookEdit"] {
        let n = (try { open --raw $state | str trim | into int } catch { 0 }) + 1
        $"($n)" | save --force $state
        if $n >= 5 and ($n mod 5) == 0 {
            let msg = $"Delegation check - hook: this is inline edit #($n) in a row with no subagent delegation. Owner policy 2026-08-03, weekly usage budget critical: Fable plans, delegates, and verifies - mechanical or multi-file execution goes to Sonnet 5 / Opus 5 subagents via the Agent tool. If the remaining work in this stretch is well-specified, stop editing inline and delegate it now; continue inline only for genuinely judgment-bound single-file changes. Subagents: ignore this nudge."
            {hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $msg}} | to json -r
        }
    } else {
        rm --force $state
    }
}
