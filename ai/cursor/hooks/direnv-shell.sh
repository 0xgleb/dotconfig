#!/usr/bin/env bash

# Prepend a cached nix-direnv export before Cursor agent shell commands.
# Cursor's non-interactive shells carry stale DIRENV_* snapshot vars, so
# direnv export returns empty unless we unset them first.

agent_env="${HOME}/.cursor/agent-env.sh"
if [[ -f "$agent_env" ]]; then
  # shellcheck source=/dev/null
  source "$agent_env"
fi

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo '{"permission": "allow"}'
  exit 0
fi

command=$(echo "$input" | jq -r '.tool_input.command // empty')
if [[ -z "$command" ]]; then
  echo '{"permission": "allow"}'
  exit 0
fi

if [[ "$command" =~ direnv[[:space:]]+(exec|export)|nix[[:space:]]+develop ]]; then
  echo '{"permission": "allow"}'
  exit 0
fi

working_directory=$(echo "$input" | jq -r '.cwd // .tool_input.working_directory // empty')
if [[ -z "$working_directory" ]]; then
  working_directory="$(pwd)"
fi

envrc_directory="$working_directory"
while [[ ! -f "${envrc_directory}/.envrc" && "$envrc_directory" != "/" ]]; do
  envrc_directory="$(dirname "$envrc_directory")"
done

if [[ ! -f "${envrc_directory}/.envrc" ]]; then
  echo '{"permission": "allow"}'
  exit 0
fi

if ! command -v direnv >/dev/null 2>&1; then
  echo '{"permission": "allow"}'
  exit 0
fi

escaped_agent_env=${agent_env//\'/\'\\\'\'}
escaped_envrc_directory=${envrc_directory//\'/\'\\\'\'}
escaped_working_directory=${working_directory//\'/\'\\\'\'}

read -r -d '' inject <<EOF || true
source '${escaped_agent_env}'; unset DIRENV_DIFF DIRENV_WATCHES IN_NIX_SHELL; cd '${escaped_envrc_directory}' && eval "\$(direnv export bash 2>/dev/null)" && cd '${escaped_working_directory}';
EOF

updated_command="${inject}${command}"
updated_input=$(echo "$input" | jq -c --arg command "$updated_command" '.tool_input | .command = $command')

jq -n --argjson updated_input "$updated_input" '{
  "permission": "allow",
  "updated_input": $updated_input
}'
