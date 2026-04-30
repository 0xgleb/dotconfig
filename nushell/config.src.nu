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

alias vi = nvim
alias vim = nvim
alias nix = nix --accept-flake-config

def evolve [] {
  print "root priviliges might be used during the rebuild"
  sudo darwin-rebuild switch -v --flake $"($env.HOME)/.config"
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
  let branch_result = do { git branch --show-current } | complete

  if $branch_result.exit_code == 0 {
    let branch_name = $branch_result.stdout | str trim
    let branch_name = if $branch_name == "" {
      (do { git rev-parse --short HEAD } | complete).stdout | str trim
    } else {
      $branch_name
    }

    if ("ZELLIJ" in $env) {
      zellij action rename-tab $branch_name
    }
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
use scripts/jf.nu
