# Nushell configuration -- loaded on shell startup
# Full reference: https://www.nushell.sh/book/configuration.html
# All settings: https://www.nushell.sh/commands/docs/config.html

# Match the archeofuturism Zellij theme without changing Ghostty's global ANSI
# palette. Nushell tables, values, syntax shapes, file names, and prompts stay
# coherent while unrelated terminal applications keep their own colors.
const archeofuturism = {
  base: "#8EA7C7"
  bright: "#E8F6FF"
  steel: "#5088B8"
  muted: "#7184A8"
  cyan: "#29E7FF"
  cyan_soft: "#86F5FF"
  mint: "#7CFFB2"
  purple: "#B79CFF"
  magenta: "#FF4FD8"
  pink: "#FF78C8"
  yellow: "#FFE66D"
  orange: "#FF9E64"
  red: "#FF5470"
  selection: "#8E3480"
}

$env.LS_COLORS = ([
  $"di=38;2;41;231;255"
  $"ln=38;2;183;156;255"
  $"ex=38;2;124;255;178"
  $"*.md=38;2;255;230;109"
  $"*.nix=38;2;183;156;255"
  $"*.rs=38;2;134;245;255"
  $"*.toml=38;2;255;158;100"
  $"*.lock=38;2;113;132;168"
  $"*.log=38;2;113;132;168"
  $"*.db=38;2;255;120;200"
] | str join ":")

$env.config = {
  show_banner: false
  edit_mode: vi

  color_config: {
    separator: $archeofuturism.steel
    leading_trailing_space_bg: { attr: "n" }
    header: { fg: $archeofuturism.cyan attr: "b" }
    empty: $archeofuturism.muted
    bool: $archeofuturism.mint
    int: $archeofuturism.mint
    filesize: $archeofuturism.cyan
    duration: $archeofuturism.purple
    date: $archeofuturism.muted
    range: $archeofuturism.purple
    float: $archeofuturism.mint
    string: $archeofuturism.base
    nothing: $archeofuturism.muted
    binary: $archeofuturism.orange
    "cell-path": $archeofuturism.cyan_soft
    row_index: { fg: $archeofuturism.mint attr: "b" }
    record: $archeofuturism.base
    list: $archeofuturism.base
    block: $archeofuturism.purple
    hints: $archeofuturism.muted
    search_result: { fg: $archeofuturism.bright bg: $archeofuturism.selection }
    shape_and: { fg: $archeofuturism.magenta attr: "b" }
    shape_binary: { fg: $archeofuturism.orange attr: "b" }
    shape_block: { fg: $archeofuturism.purple attr: "b" }
    shape_bool: $archeofuturism.mint
    shape_closure: { fg: $archeofuturism.purple attr: "b" }
    shape_directory: $archeofuturism.cyan
    shape_external: $archeofuturism.cyan_soft
    shape_externalarg: $archeofuturism.base
    shape_filepath: $archeofuturism.cyan_soft
    shape_flag: { fg: $archeofuturism.pink attr: "b" }
    shape_float: $archeofuturism.mint
    shape_glob_interpolation: $archeofuturism.cyan
    shape_globpattern: $archeofuturism.cyan_soft
    shape_int: $archeofuturism.mint
    shape_keyword: { fg: $archeofuturism.magenta attr: "b" }
    shape_list: { fg: $archeofuturism.purple attr: "b" }
    shape_literal: $archeofuturism.base
    shape_match_pattern: $archeofuturism.yellow
    shape_nothing: $archeofuturism.muted
    shape_operator: { fg: $archeofuturism.magenta attr: "b" }
    shape_pipe: { fg: $archeofuturism.steel attr: "b" }
    shape_range: { fg: $archeofuturism.purple attr: "b" }
    shape_record: { fg: $archeofuturism.purple attr: "b" }
    shape_redirection: { fg: $archeofuturism.orange attr: "b" }
    shape_signature: { fg: $archeofuturism.cyan attr: "b" }
    shape_string: $archeofuturism.base
    shape_string_interpolation: $archeofuturism.cyan_soft
    shape_table: { fg: $archeofuturism.purple attr: "b" }
    shape_variable: $archeofuturism.cyan
    shape_vardecl: $archeofuturism.cyan
  }

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
    {
      name: force_completion_menu
      modifier: shift
      keycode: backtab
      mode: [vi_normal vi_insert]
      event: {
        until: [
          { send: menu name: completion_menu }
          { send: MenuPrevious }
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

# OpenSSH copies the local TERM into remote PTYs. Most servers do not ship
# Ghostty's terminfo yet, so use the ubiquitous compatible entry for SSH only;
# local Ghostty and Zellij sessions keep the richer xterm-ghostty capabilities.
def --wrapped ssh [...args: string] {
  with-env { TERM: "xterm-256color" } { ^ssh ...$args }
}

def run-evolve-step [label: string, command: closure] {
  print $"evolve: ($label)"
  do $command
}

def evolve [] {
  let config_root = ($env.HOME | path join ".config")
  let pi_bin = ($env.HOME | path join ".pi" "agent" "bin" "pi")
  # `nix` stays unprefixed on purpose — it is aliased to add --accept-flake-config.
  run-evolve-step "sudo refresh" {|| ^sudo -v }
  run-evolve-step "flake update" {|| nix -v flake update --flake $config_root }
  run-evolve-step "Darwin switch" {|| ^sudo darwin-rebuild switch -v --flake $config_root }
  # The package build asserts both sides of the patched Pi continuation contract.
  # Verify the stable managed entrypoint directly: the generic user profile can
  # retain an older build with the same semantic version.
  run-evolve-step "Pi host verification" {|| ^$pi_bin --version }
  run-evolve-step "Nix store GC" {|| nix -v store gc }
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

# Tab names belong to the layout, not to the shell. A tab groups panes by what
# they are FOR - orchestration, opus workers, grok workers - and renaming the
# active tab from whichever pane last rendered a prompt overwrites that with
# the cwd of an unrelated shell.
$env.PROMPT_COMMAND = {||
  let path = if $env.PWD == $nu.home-dir { "~" } else { $env.PWD | path basename }

  let who = (whoami)
  if $who == "root" {
    $"(ansi {fg: $archeofuturism.red attr: 'b'})ROOT(ansi reset) (ansi {fg: $archeofuturism.cyan})($path)(ansi reset) # "
  } else {
    $"(ansi {fg: $archeofuturism.cyan})($path)(ansi reset) (ansi {fg: $archeofuturism.purple})$(ansi reset) "
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
