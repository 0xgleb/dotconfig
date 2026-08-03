# `fj cheatsheet` — a rendered nushell/shell quick reference.
#
# The reference lives as structured data (sections of left/right entries plus
# free-form notes) so it renders aligned and stays easy to extend; the renderer
# computes column widths instead of every row hard-coding its own padding.

# Render the cheatsheet, optionally filtered to sections matching `topic`.
export def main [topic?: string] {
  let all = (sections)
  let shown = if ($topic | is-empty) {
    $all
  } else {
    let needle = ($topic | str lowercase)
    $all | where {|s| ($s.title | str lowercase) | str contains $needle }
  }

  if ($shown | is-empty) {
    let titles = ($all | get title | str join ", ")
    print $"no cheatsheet section matching '($topic)'. sections: ($titles)"
    return
  }

  for s in $shown {
    print $"(ansi cyan_bold)($s.title)(ansi reset)"

    let entries = ($s.entries? | default [])
    if ($entries | is-not-empty) {
      let width = ($entries | get left | each { str length } | math max)
      for e in $entries {
        print $"  ($e.left | fill --alignment left --width $width)   ($e.right)"
      }
    }

    for note in ($s.notes? | default []) {
      print $"  ($note)"
    }

    print ""
  }
}

def sections [] {
  [
    {
      title: "Navigation"
      entries: [
        { left: "z <partial>", right: "jump to a dir (zoxide, learns from cd)" }
        { left: "zi", right: "interactive zoxide picker" }
        { left: "cd -", right: "go back to the previous directory" }
        { left: "ls | sort-by size", right: "list files sorted by size" }
        { left: "ls **/*.nix", right: "recursive glob listing" }
      ]
    }
    {
      title: "History & Search"
      entries: [
        { left: "ctrl+r", right: "fuzzy history search (atuin)" }
        { left: "history", right: "show history as a table" }
        { left: "history | where command =~ docker", right: "search history" }
        { left: "atuin search <query>", right: "search history from the CLI" }
      ]
    }
    {
      title: "Pipes & Tables"
      entries: [
        { left: "ls | where size > 1mb", right: "filter files by size" }
        { left: "ls | sort-by modified -r", right: "newest first" }
        { left: "ps | where name =~ nvim", right: "find processes" }
        { left: "ps | where cpu > 10", right: "high-cpu processes" }
        { left: "open file.json", right: "auto-parse json/yaml/toml/csv" }
        { left: "open file.json | get key.nested", right: "extract a nested value" }
        { left: "open file.json | to yaml", right: "convert between formats" }
        { left: "$env | transpose key value", right: "env vars as a table" }
        { left: "sys host", right: "system info" }
      ]
    }
    {
      title: "Strings & Data"
      entries: [
        { left: "'hello' | str upcase", right: "string operations" }
        { left: "'a b' | split row ' '", right: "split into a list" }
        { left: "[1 2 3] | each {|x| $x * 2 }", right: "map over a list" }
        { left: "[1 2 3] | reduce {|it, acc| $acc + $it }", right: "fold" }
        { left: "1..10 | where {|x| $x mod 2 == 0 }", right: "filter a range" }
      ]
    }
    {
      title: "Files & Text"
      entries: [
        { left: "open file.txt", right: "read a file (auto-detects format)" }
        { left: "open file.txt | lines", right: "read as a list of lines" }
        { left: "'content' | save file.txt", right: "write a file" }
        { left: "'more' | save -a file.txt", right: "append to a file" }
        { left: "glob **/*.log", right: "find files by pattern" }
      ]
    }
    {
      title: "Logs & Debugging"
      entries: [
        { left: "open /tmp/sync-notes.out | lines | last 50", right: "tail syncNotes log" }
        { left: "ls /var/log/ | sort-by modified -r", right: "recent log files" }
        { left: "ls ~/Library/Logs/ | sort-by modified -r", right: "macOS app logs" }
        { left: "launchctl list | lines", right: "running launchd services" }
        { left: "launchctl print gui/(id -u)", right: "user agent details" }
        { left: "journalctl", right: "systemd logs (nixos only)" }
      ]
      notes: [
        ""
        "log locations:"
        "  /tmp/sync-notes.out   syncNotes service"
        "  ~/Library/Logs/       macOS application logs"
        "  /var/log/             system logs"
        "  /nix/var/log/         nix build logs"
      ]
    }
    {
      title: "Nix"
      entries: [
        { left: "which <cmd>", right: "is a command from the nix store?" }
        { left: "darwin-rebuild switch --flake ~/.config", right: "rebuild the system" }
        { left: "darwin-rebuild build --flake ~/.config", right: "build without applying" }
        { left: "nix run nixpkgs#<pkg>", right: "one-off tool without installing" }
        { left: "nix-store -q --references /nix/store/<h>", right: "package dependencies" }
      ]
      notes: [
        ""
        "audit PATH for non-nix entries:"
        "  $env.PATH | where {|p| not ($p | str starts-with /nix) }"
      ]
    }
    {
      title: "Completions (carapace)"
      notes: [
        "tab          complete word-by-word (ghost text) or open the menu"
        "carapace ships completions for git, docker, gh, cargo, kubectl, ..."
        "they activate automatically — just tab after a command + space"
      ]
    }
    {
      title: "Nushell vs Bash/Zsh"
      entries: [
        { left: "echo $VAR", right: "$env.VAR" }
        { left: "export X=1", right: "$env.X = '1'" }
        { left: "cmd > /dev/null", right: "cmd | ignore" }
        { left: "cmd 2>&1", right: "cmd o+e>| ..." }
        { left: "$(cmd)", right: "(cmd)" }
        { left: "cmd1 | cmd2", right: "cmd1 | cmd2 (but structured data)" }
        { left: "if [ -f x ]; then", right: "if ('x' | path exists) { }" }
        { left: "for f in *.txt", right: "for f in (glob *.txt) { }" }
        { left: "cmd &", right: "not supported (use par-each)" }
        {
          left: "source .env"
          right: "open .env | lines | parse '{k}={v}' | transpose -r -d | load-env"
        }
      ]
    }
  ]
}
