#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  printf 'GitButler wrapper requires the real but executable path.\n' >&2
  exit 2
fi

real_but=$1
shift

command_dir=$PWD
explicit_current_dir=0
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index += 1)); do
  argument=${arguments[$index]}
  case "$argument" in
    -C | --current-dir)
      if ((index + 1 >= ${#arguments[@]})); then
        printf '%s requires a path.\n' "$argument" >&2
        exit 2
      fi
      command_dir=${arguments[$((index + 1))]}
      explicit_current_dir=1
      break
      ;;
    --current-dir=*)
      command_dir=${argument#*=}
      explicit_current_dir=1
      break
      ;;
    --*) ;;
    -*) ;;
    *) break ;;
  esac
done

git_dir=$(git -C "$command_dir" rev-parse --absolute-git-dir 2>/dev/null || true)
common_dir=$(git -C "$command_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
git_root=$(git -C "$command_dir" rev-parse --show-toplevel 2>/dev/null || true)

if [[ -n "$git_dir" && -n "$common_dir" && "$git_dir" != "$common_dir" ]]; then
  printf 'GitButler is disabled in linked worktrees because it operates on the main virtual workspace. Use worktree-local Git for this checkout.\n' >&2
  exit 2
fi

if [[ "$explicit_current_dir" -eq 0 && -n "$git_root" ]]; then
  exec "$real_but" -C "$git_root" "$@"
fi

exec "$real_but" "$@"
