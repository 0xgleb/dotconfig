export def extract-content [hook_data: record] -> string {
  let tool = ($hook_data.tool_name? | default "")
  if $tool == "Write" {
    $hook_data.tool_input.content? | default ""
  } else if $tool == "Edit" {
    $hook_data.tool_input.new_string? | default ""
  } else {
    ""
  }
}

export def has-non-ascii [text: string] -> bool {
  ($text | encode utf-8 | bytes length) != ($text | split chars | length)
}

export def check-unicode [hook_data: record] -> record {
  let content = (extract-content $hook_data)
  if $content == "" {
    return {}
  }

  if (has-non-ascii $content) {
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse"
        permissionDecision: "deny"
        permissionDecisionReason: "Content contains non-ASCII Unicode characters. Use ASCII equivalents: -- instead of em dash, -> instead of arrow, etc."
      }
    }
  } else {
    {}
  }
}

def main [] {
  let input = ($in | from json)

  let tool = ($input.tool_name? | default "")
  if $tool not-in ["Edit" "Write"] {
    return
  }

  let result = (check-unicode $input)
  if ($result | is-not-empty) {
    $result | to json --raw
  }
}
