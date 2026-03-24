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

def ask [question: string, context: closure] {
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

$env.PROMPT_COMMAND = {||
  let path = if $env.PWD == $nu.home-dir {
    "~"
  } else {
    $env.PWD | path basename
  }

  let origin = do { git remote get-url origin } | complete
  let name = if $origin.exit_code == 0 {
    $origin.stdout | str trim | split row "/" | last | str replace ".git" ""
  } else {
    ""
  }

  if ("ZELLIJ" in $env) {
    let branch = do { git branch --show-current } | complete
    if $branch.exit_code == 0 and ($branch.stdout | str trim) != "" {
      zellij action rename-tab $"($name):($branch.stdout | str trim)"
    }
  }

  let repo_name = if $name != "" {
    $"(ansi yellow)\(($name)\)(ansi reset) "
  } else {
    ""
  }

  let who = (whoami)
  if $who == "root" {
    $"(ansi red_bold)ROOT(ansi reset) (ansi yellow)($repo_name)(ansi reset)($path) # "
  } else {
    $"(ansi cyan)($repo_name)(ansi reset)($path) > "
  }
}

$env.PROMPT_COMMAND_RIGHT = ""


use scripts/fj/
use scripts/jf.nu
