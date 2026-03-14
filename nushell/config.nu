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
          { send: HistoryHintComplete }
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

alias l = ls -la

# Prompt: closure called before each line
# {|| } is a closure with no parameters
# https://www.nushell.sh/book/coloring_and_theming.html#prompt-configuration
$env.PROMPT_COMMAND = {||
  let path = ($env.PWD | path basename)
  $"(ansi cyan)($path)(ansi reset) > "
}

$env.PROMPT_COMMAND_RIGHT = ""
