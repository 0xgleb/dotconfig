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

def --wrapped l [...args: string] {
  ls -a ...$args
}

alias g = git
alias vi = nvim
alias vim = nvim
alias nix = nix --accept-flake-config

def darwin-evolve [] {
  sudo echo authorized
  nix -v flake update --flake $'($env.HOME)/.config'
  sudo darwin-rebuild switch -v --flake $"($env.HOME)/.config"
  nix -v store gc
}

alias evolve = darwin-evolve

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
    claude -p $prompt
    | str trim
    | lines
    | where $it !~ "```"
    | str join "\n"
    | pbcopy
  )

  print $"\nA: (pbpaste)\n"
}

def fix [context: closure, prompt?: string] {
  do -i { do $context }
  let exit_code = $env.LAST_EXIT_CODE

  if $exit_code == 0 {
    print "Already passing, nothing to fix."
    return
  }

  print $"Command failed with exit code ($exit_code), re-running to capture output for Claude..."

  do -i { do $context } out> /tmp/claude-fix-stdout err> /tmp/claude-fix-stderr

  let stdout = try { open /tmp/claude-fix-stdout | into string } catch { "" }
  let stderr = try { open /tmp/claude-fix-stderr | into string } catch { "" }

  let parts = [
    "The following command failed. Fix the issue."
    $"stdout:\n($stdout)"
    $"stderr:\n($stderr)"
  ]

  let parts = if $prompt != null {
    $parts | append $"Additional context: ($prompt)"
  } else {
    $parts
  }

  claude -p ($parts | str join "\n\n")
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


use scripts/fj/
alias f = fj
alias j = fj
