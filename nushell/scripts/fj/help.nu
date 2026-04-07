const command_help = {
  do: "fj do — check, then commit or fix

  Runs unfuck + checks. On pass, opens $EDITOR for a commit message
  and commits with git add -A. On fail, opens $EDITOR for context,
  then sends check output + context to claude --continue."

  check: "fj check — run repo-specific checks

  Auto-unfucks first (submodules, symlinks), then runs the full
  check suite for the current repo (cargo, nextest, clippy, bun, etc)."

  unfuck: "fj unfuck — fix common repo issues

  Detects and fixes:
    - broken submodule symlinks in worktrees (lib/)
    - typechanged files (e.g. CLAUDE.md replaced with regular file)"

  issue: "fj issue — github issues

  SUBCOMMANDS
    fj issue list [flags]    list issues (passes flags to gh)
    fj issue view <n>        view issue in markdown format
      --web (-w)             open in browser
      --comments (-c)        show comments
    fj issue <subcommand>    other gh issue subcommands"

  pr: "fj pr — pull requests

  SUBCOMMANDS
    fj pr list [flags]       list PRs (passes flags to gh)
    fj pr view [n]           view PR in markdown format (default: current branch)
      --web (-w)             open in browser
      --comments (-c)        show comments
    fj pr <subcommand>       other gh pr subcommands"

  md: "fj md — markdown vault sync

  SUBCOMMANDS
    fj md plan [flags]       compute a sync plan
      --org <path>           single org root
      --vault <path>         vault path
      --config <file>        config file
      --out <file>           output plan file
      --verbose (-v)         show per-target scan progress
    fj md diff [flags]       show diffs for planned changes
      --stat                 summary only, no diffs
    fj md sync [flags]       apply a sync plan
      --yes (-y)             skip confirmation
    fj md                    plan + diff + apply in one step"

  ui: "fj ui — launch gitui"

  mut: "fj mut [-a] — gt modify

  Shorthand for gt modify. Pass -a to stage all files."

  help: "fj help [command] — show help

  Without arguments, shows all commands.
  With a command name, shows detailed help for that command."
}

export def show [topic?: string] {
  if $topic == null or $topic == "" {
    print (overview)
    return
  }

  let help_text = ($command_help | get -o $topic)
  if $help_text != null {
    print $help_text
  } else {
    print $"no help for '($topic)'. try `fj help` for available commands."
  }
}

def overview [] {
  [
    "fj — unified dev command"
    ""
    "USAGE"
    "  fj <command> [args]"
    ""
    "COMMANDS"
    "  (no args)       git status + gt ls"
    "  do              check -> commit on pass, claude on fail"
    "  check           run repo-specific checks (auto-unfucks first)"
    "  unfuck          fix common repo issues (submodules, symlinks)"
    "  issue list      list issues"
    "  issue view <n>  view issue in markdown format"
    "  pr list         list pull requests"
    "  pr view [n]     view PR in markdown format"
    "  md plan         compute vault sync plan"
    "  md diff         show diffs for planned changes"
    "  md sync         apply sync plan"
    "  md              plan + diff + apply"
    "  ui              gitui"
    "  mut [-a]        gt modify"
    "  help [cmd]      show help"
    ""
    "GRAPHITE (gt)"
    "  ss, create, sync, co, ls, ll, restack, absorb, untrack, squash, ..."
    ""
    "GIT"
    "  diff, add, status, stash, push, pull, show, blame, branch,"
    "  commit, reset, restore, switch, tag, fetch, rebase, merge, log, ..."
  ] | str join "\n"
}
