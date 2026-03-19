# Nushell configuration -- loaded on shell startup
# Full reference: https://www.nushell.sh/book/configuration.html
# All settings: https://www.nushell.sh/commands/docs/config.html

$env.config = {
  show_banner: false
  edit_mode: vi                  # vi keybindings (normal/insert modes)

  completions: {
    case_sensitive: false
    quick: true                  # auto-complete single match without tab
    partial: true                # complete partial matches
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

  # https://www.nushell.sh/book/history.html
  history: {
    max_size: 100_000
    sync_on_enter: true          # write to history on each command
    file_format: "sqlite"        # sqlite enables cross-session search
  }
}

def --wrapped l [...args: string] {
  ls -a ...$args
}

alias vi = nvim 
alias vim = nvim

# fj — unified git/graphite/gitui command
# Routing logic duplicated in fj.nu for testability (see fj.test.nu)
const gt_commands = [create modify ss submit sync co checkout top bottom up down restack reorder move absorb rename ls ll log init get guide demo feedback]

def --wrapped fj [...args: string] {
  if ($args | length) == 0 {
    ^git status
    ^gt ls
  } else if $args.0 == "ui" {
    ^gitui ...($args | skip 1)
  } else if $args.0 == "pr" {
    ^gh pr ...($args | skip 1)
  } else if $args.0 == "mut" {
    ^gt modify ...($args | skip 1)
  } else if $args.0 in $gt_commands {
    ^gt ...$args
  } else {
    ^git ...$args
  }
}

# Prompt: closure called before each line
# {|| } is a closure with no parameters
# https://www.nushell.sh/book/coloring_and_theming.html#prompt-configuration
$env.PROMPT_COMMAND = {||
  let path = if $env.PWD == $nu.home-dir {
    "~"
  } else {
    $env.PWD | path basename
  }
  let who = (whoami)
  if $who == "root" {
    $"(ansi red_bold)ROOT(ansi reset) (ansi yellow)($path)(ansi reset) # "
  } else {
    $"(ansi cyan)($path)(ansi reset) > "
  }
}

$env.PROMPT_COMMAND_RIGHT = ""

use fix-worktree-submodules.nu
use devkit.nu
