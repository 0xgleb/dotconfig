const command_help = {
  do: "fj do — check, then commit or fix

  Runs checks. On pass, opens $EDITOR for a commit message and commits
  with git add -A. On fail, opens $EDITOR for context, then sends check
  output + context to claude --continue."

  clanker: "fj clanker — launch claude code, cranked up

  Starts an interactive claude session with:
    - ultracode      xhigh effort + standing dynamic-workflow orchestration
    - auto mode      --permission-mode auto
    - flicker-free   fullscreen alt-screen renderer (tui: fullscreen)
    - resume         picks up the most recent session here (--continue)

  Resumes by default, but only when a session for this directory
  exists; in a fresh, renamed, or moved directory it starts fresh
  instead of erroring. Override the resume behaviour:
    fj clanker                         resume the most recent session here
    fj clanker \"refactor the router\"   resume, then send an initial prompt
    fj clanker --new                   force a fresh session instead
    fj clanker --new \"scaffold X\"       fresh session with an initial prompt
    fj clanker -r <id>                 resume a specific session (suppresses
                                       the implicit --continue)
  Any other args pass straight through to claude."

  check: "fj check — run repo-specific checks

  Runs the full check suite for the current repo (cargo, nextest,
  clippy, bun, etc)."

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

  infra: "fj infra — infrastructure management

SUBCOMMANDS
  fj infra consequences   terraform plan      (nix run .#tfPlan)
  fj infra enact          terraform apply     (nix run .#tfApply)
  fj infra edit vars      edit encrypted vars (nix run .#tfVars)

Thin aliases over the packaged infra apps (infra/default.nix), which own
auto-init, tfvars decrypt/re-encrypt, and identity resolution (default
~/.ssh/dotconfig-nixos). Secrets managed via rage."

  take: "fj take <ours|theirs> <path> — resolve a merge conflict

  Checks out the chosen version of a conflicted file and stages it.

  EXAMPLES
    fj take ours src/lib.rs
    fj take theirs SPEC.md"

  cheatsheet: "fj cheatsheet [topic] — shell quick reference

  Prints a grouped nushell/shell cheatsheet (navigation, pipes, logs,
  nix, bash-to-nushell translations, ...). Pass a topic to show only
  matching sections, e.g. `fj cheatsheet nix`."

  ui: "fj ui — launch gitui"

  mut: "fj mut [-a] — stack modify (amend)

  Shorthand for the stack backend's modify/amend. Pass -a to stage all files.
  Backend depends on the repo: gt in graphite orgs (rainlanguage, st0x),
  gitbutler-cli (but) elsewhere when installed, otherwise git."

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
    "  (no args)       git status (+ gt ls in graphite repos)"
    "  do              check -> commit on pass, claude on fail"
    "  clanker         launch claude, resume by default (--new for fresh)"
    "  check           run repo-specific checks"
    "  issue list      list issues"
    "  issue view <n>  view issue in markdown format"
    "  pr list         list pull requests"
    "  pr view [n]     view PR in markdown format"
    "  md plan         compute vault sync plan"
    "  md diff         show diffs for planned changes"
    "  md sync         apply sync plan"
    "  md              plan + diff + apply"
    "  infra consequences  terraform plan"
    "  infra enact         terraform apply"
    "  infra edit vars     edit encrypted tfvars"
    "  take <v> <path> resolve conflict (ours/theirs) and stage"
    "  cheatsheet      shell quick reference (`fj cheatsheet [topic]`)"
    "  ui              gitui"
    "  mut [-a]        stack modify (gt/but/git by repo — see STACK)"
    "  help [cmd]      show help"
    ""
    "STACK (repo-dependent backend, verbs translated)"
    "  ss, create, sync, co, ls, ll, restack, absorb, untrack, squash, mut, ..."
    "  routed to:  gt   in ~/code/rainlanguage/* and ~/code/st0x/*"
    "              but  in other repos when gitbutler-cli is installed"
    "              git  otherwise"
    "  e.g. mut -> gt modify / but amend / git commit --amend;"
    "       co  -> gt co     / but apply / git checkout"
    "  graphite-only verbs (up/down/top/bottom, ...) error on but/git"
    ""
    "GIT"
    "  diff, add, status, stash, push, pull, show, blame, branch,"
    "  commit, reset, restore, switch, tag, fetch, rebase, merge, log, ..."
  ] | str join "\n"
}
