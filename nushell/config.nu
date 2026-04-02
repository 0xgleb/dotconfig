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
def --wrapped jf [...args: string] { fj ...$args }
def "jf check" [] { fj check }
def --wrapped "jf issue" [...args: string] { fj issue ...$args }
def --wrapped "jf pr" [...args: string] { fj pr ...$args }
def --wrapped "jf md" [...args: string] { fj md ...$args }
def "jf md plan" [--org: string, --vault: string, --config: string, --out: string, --verbose (-v)] { fj md plan --org $org --vault $vault --config $config --out $out --verbose=$verbose }
def "jf md diff" [--plan: string, --org: string, --vault: string, --config: string, --stat] { fj md diff --plan $plan --org $org --vault $vault --config $config --stat=$stat }
def "jf md sync" [--plan: string, --yes (-y)] { fj md sync --plan $plan --yes=$yes }

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

use scripts/fix-worktree-submodules.nu
use scripts/fj/
