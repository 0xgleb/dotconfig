#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
REPO=$(basename "$CWD")
BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
PR=$(gh pr view --json number --jq '.number' 2>/dev/null || echo "unknown")
ISSUE=$(gh issue list --assignee @me --state open --json number --jq '.[0].number' 2>/dev/null || echo "unknown")
DOC_DIR="$CWD/.claude"
DOC_PATH="$DOC_DIR/handoff.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

DOC_CHANGED="false"
if [ -f "$DOC_PATH" ]; then
  LAST_MOD=$(stat -f %m "$DOC_PATH" 2>/dev/null || stat -c %Y "$DOC_PATH" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  AGE=$(( NOW - LAST_MOD ))
  if [ "$AGE" -lt 300 ]; then
    DOC_CHANGED="true"
  fi
fi

cat <<REASON
{"decision": "block", "reason": "STOP HOOK TRIGGERED — follow this protocol exactly:\n\n## Context\n- repo: $REPO\n- branch: $BRANCH\n- pr: $PR\n- issue: $ISSUE\n- handoff_doc: $DOC_PATH\n- doc_recently_changed: $DOC_CHANGED\n- timestamp: $TIMESTAMP\n\n## Protocol\n\n1. Check your task list for incomplete tasks you are NOT blocked on.\n\n2. IF there are incomplete non-blocked tasks:\n   - Commit any uncommitted work\n   - Continue working on the next task\n   - Do NOT stop\n\n3. IF all remaining tasks are blocked (or all complete):\n   a. If handoff doc was recently changed (doc_recently_changed=true), read it first — check if the user replied or if anything changed that unblocks you. If unblocked, update task list and continue working.\n   b. Write (prepend) a new entry to the handoff doc at $DOC_PATH. Create the file and directory if needed. The entry format:\n\n---\n\nIf ALL tasks are complete, prepend this:\n\n\`\`\`markdown\n---\nrepo: $REPO\nbranch: $BRANCH\npr: $PR\nissue: $ISSUE\nstatus: complete\ntimestamp: $TIMESTAMP\n---\n\n# [complete] $TIMESTAMP\n\nAll tasks finished.\n\n## Summary\n<what was accomplished>\n\`\`\`\n\nIf BLOCKED, prepend this:\n\n\`\`\`markdown\n---\nrepo: $REPO\nbranch: $BRANCH\npr: $PR\nissue: $ISSUE\nstatus: blocked\ntimestamp: $TIMESTAMP\n---\n\n# [blocked] $TIMESTAMP\n\n## Why still blocked\n<explain what is blocking you and why>\n\n## Questions\n### Q1: <question>\n\n**Response:**\n\n\n### Q2: <question>\n\n**Response:**\n\n\n## Summary\n<what was accomplished so far>\n\`\`\`\n\n   c. After writing, commit the handoff doc and any other uncommitted work\n   d. Then stop\n\nIMPORTANT: The handoff doc is prepend-only. Read existing content and place the new entry ABOVE it. Never delete or modify previous entries."}
REASON

exit 0
