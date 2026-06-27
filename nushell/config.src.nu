# Nushell configuration -- loaded on shell startup
# Full reference: https://www.nushell.sh/book/configuration.html
# All settings: https://www.nushell.sh/commands/docs/config.html

$env.config = {
  show_banner: false
  edit_mode: vi

  completions: {
    case_sensitive: false
    quick: true
    partial: true
  }

  keybindings: [
    {
      name: accept_suggestion
      modifier: none
      keycode: tab
      mode: [vi_normal vi_insert]
      event: {
        until: [
          { send: HistoryHintWordComplete }
          { send: menu name: completion_menu }
          { send: MenuNext }
        ]
      }
    }
  ]

  history: {
    max_size: 100_000
    sync_on_enter: false
    file_format: "sqlite"
  }
}

alias g = git
alias vi = nvim
alias vim = nvim
alias nix = nix --accept-flake-config
alias l = ls -a

def evolve [] {
  # `nix` stays unprefixed on purpose — it is aliased to add --accept-flake-config.
  ^sudo -v
  nix -v flake update --flake $"($env.HOME)/.config"
  ^sudo darwin-rebuild switch -v --flake $"($env.HOME)/.config"
  nix -v store gc
}

def ask [context: closure, question: string] {
  print $"\nQ: ($question)?"

  let prompt = [
    "Request:"
    $"( $question | str trim )"
    "Below is some context to help you answer"
    "---"
    $"( do $context )"
    "---"
    "Response:"
  ] | str join "\n\n"

  let response = (
    ^claude -p $prompt
    | str trim
    | lines
    | where $it !~ "```"
    | str join "\n"
  )

  if (which pbcopy | is-not-empty) { $response | ^pbcopy }
  print $"\nA: ($response)\n"
}

def fix [context: closure, prompt?: string] {
  let result = (do $context | complete)

  if $result.exit_code == 0 {
    print "Already passing, nothing to fix."
    return
  }

  print $"Command failed with exit code ($result.exit_code), sending output to Claude..."

  let parts = [
    "The following command failed. Fix the issue."
    $"stdout:\n($result.stdout)"
    $"stderr:\n($result.stderr)"
  ]

  let parts = if ($prompt | is-not-empty) {
    $parts | append $"Additional context: ($prompt)"
  } else {
    $parts
  }

  ^claude -p ($parts | str join "\n\n")
}

$env.PROMPT_COMMAND = {||
  let path = if $env.PWD == $nu.home-dir { "~" } else { $env.PWD | path basename }

  if ("ZELLIJ" in $env) {
    let common_dir_result = do { git rev-parse --path-format=absolute --git-common-dir } | complete
    let tab_name = if $common_dir_result.exit_code == 0 {
      $common_dir_result.stdout | str trim | path dirname | path basename
    } else {
      $path
    }
    zellij action rename-tab $tab_name
  }

  let who = (whoami)
  if $who == "root" {
    $"(ansi red_bold)ROOT(ansi reset) ($path) # "
  } else {
    $"($path) $ "
  }
}

$env.PROMPT_COMMAND_RIGHT = ""


use fj/
# `f`/`j` alias the `jf` binary, NOT the `fj` module: a nushell alias to a module
# command does not compose with subcommands (`f infra provision` would call
# `fj`'s main with `infra provision` as args -> "unknown fj command: infra").
# The `jf` binary has explicit `main <sub>` forwarders, so `f infra provision`
# dispatches correctly. Use the bare `fj` word for the faster in-process module.
alias f = jf
alias j = jf
