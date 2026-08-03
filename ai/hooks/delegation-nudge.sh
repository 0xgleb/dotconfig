#!/usr/bin/env bash
# Delegation wrist-slap: counts consecutive Edit/Write tool calls per session
# and injects a nudge into the model context every 5th one until an Agent
# delegation (or a fresh user prompt) resets the streak.
#
# Routing is done by the settings.json matchers, not here: this script only
# ever receives Edit|Write|MultiEdit|NotebookEdit (streak++), Agent|Task
# (reset), or UserPromptSubmit events with no tool_name (reset). Read/Bash
# in between never reach it, so an edit streak survives interleaved reads.
set -euo pipefail
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // "unknown"' | tr -cd 'a-zA-Z0-9-')
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
state="/tmp/claude-delegation-streak-${session}"
case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    n=$(cat "$state" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s' "$n" > "$state"
    if [ "$n" -ge 5 ] && [ $((n % 5)) -eq 0 ]; then
      jq -n --arg ctx "Delegation check (hook): this is inline edit #${n} in a row with no subagent delegation. Owner policy 2026-08-03, weekly usage budget critical: Fable plans, delegates, and verifies - mechanical or multi-file execution goes to Sonnet 5 / Opus 5 subagents via the Agent tool. If the remaining work in this stretch is well-specified, stop editing inline and delegate it now; continue inline only for genuinely judgment-bound single-file changes. (Subagents: ignore this nudge.)" \
        '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
    fi
    ;;
  *)
    rm -f "$state"
    ;;
esac
