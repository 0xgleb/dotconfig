use std/log

const PLAN_VERSION = 1
const DEFAULT_PLAN_PATH = "~/.config/.mdup-plan.nuon"

def file-hash [path: string] {
  open --raw $path | hash md5
}

def fmt-content [path: string] {
  let tmp = (mktemp --suffix .md)
  cp $path $tmp
  try { do { deno fmt --quiet $tmp } | complete } catch {}
  let content = (open --raw $tmp)
  rm -f $tmp
  $content
}

def fmt-copy [source: string, dest: string] {
  cp $source $dest
  try { do { deno fmt --quiet $dest } | complete } catch {}
}

def compute-actions [targets: table<name: string, path: string>, notes_root: string] {
  $targets | each {|target|
    if not ($target.path | path exists) {
      log warning $"($target.name): path ($target.path) does not exist, skipping"
      return []
    }

    let repo_notes = $"($notes_root)/($target.name)"
    let files = (md-files $target.path)
    log info $"($target.name): ($target.path) -> ($files | length) md file\(s)"

    $files | each {|file|
      let note_file = ($file | str replace '.local/' '' | undot $in)
      let source = $"($target.path)/($file)"
      let destination = $"($repo_notes)/($note_file)"

      if not ($source | path exists) {
        log debug $"($target.name)/($note_file): source missing from disk, skipping"
        return null
      }

      if not ($destination | path exists) {
        let line_count = (open --raw $source | lines | length)
        log debug $"($target.name)/($note_file): new \(($line_count) lines)"
        {
          action: "create"
          repo_name: $target.name
          note_file: $note_file
          source: $source
          destination: $destination
          source_hash: (file-hash $source)
          destination_hash: null
          adds: $line_count
          dels: 0
        }
      } else if (fmt-content $source) != (fmt-content $destination) {
        let source_modified = (ls -l $source | first | get modified)
        let destination_modified = (ls -l $destination | first | get modified)

        let newer_size = if $source_modified > $destination_modified {
          ls -l $source | first | get size | into int
        } else {
          ls -l $destination | first | get size | into int
        }
        let older_size = if $source_modified > $destination_modified {
          ls -l $destination | first | get size | into int
        } else {
          ls -l $source | first | get size | into int
        }

        if $newer_size == 0 and $older_size > 0 {
          log warning $"($target.name)/($note_file): blocked -- empty file would overwrite non-empty"
          {
            action: "blocked"
            repo_name: $target.name
            note_file: $note_file
            source: $source
            destination: $destination
            source_hash: (file-hash $source)
            destination_hash: (file-hash $destination)
            reason: "empty file would overwrite non-empty file"
            adds: 0
            dels: 0
          }
        } else {
          let tmp = (mktemp -d)
          let fmt_old = $"($tmp)/old.md"
          let fmt_new = $"($tmp)/new.md"
          if $source_modified > $destination_modified {
            fmt-copy $destination $fmt_old
            fmt-copy $source $fmt_new
          } else {
            fmt-copy $source $fmt_old
            fmt-copy $destination $fmt_new
          }
          let stats = (diff-stats $fmt_old $fmt_new)
          rm -rf $tmp

          let direction = if $source_modified > $destination_modified { "forward" } else { "reverse" }
          let arrow = if $direction == "forward" { "repo -> vault" } else { "vault -> repo" }
          log debug $"($target.name)/($note_file): changed \(($arrow), +($stats.adds) -($stats.dels))"

          {
            action: $direction
            repo_name: $target.name
            note_file: $note_file
            source: $source
            destination: $destination
            source_hash: (file-hash $source)
            destination_hash: (file-hash $destination)
            adds: $stats.adds
            dels: $stats.dels
          }
        }
      } else {
        log debug $"($target.name)/($note_file): identical"
        null
      }
    }
  } | flatten | compact
}

def format-action [a: record] {
  let direction = match $a.action {
    "create" => $"(ansi green)+  new(ansi reset)"
    "forward" => $"(ansi yellow)~  repo -> vault(ansi reset)"
    "reverse" => $"(ansi cyan)~  vault -> repo(ansi reset)"
    "blocked" => $"(ansi red)!  BLOCKED(ansi reset)"
    _ => $"?  ($a.action)"
  }

  let stats = match $a.action {
    "create" => $"(ansi green)+($a.adds)(ansi reset)"
    "blocked" => $"(ansi red)($a.reason)(ansi reset)"
    _ => $"(ansi green)+($a.adds)(ansi reset) (ansi red)-($a.dels)(ansi reset)"
  }

  $"  ($direction)  ($a.repo_name)/($a.note_file)  ($stats)"
}

def action-diff [a: record] {
  let tmp = (mktemp -d)

  let result = match $a.action {
    "create" => {
      let formatted = $"($tmp)/new.md"
      fmt-copy $a.source $formatted
      do { diff -u /dev/null $formatted } | complete | get stdout
    }
    "forward" => {
      let old = $"($tmp)/old.md"
      let new = $"($tmp)/new.md"
      fmt-copy $a.destination $old
      fmt-copy $a.source $new
      do { diff -u $old $new } | complete | get stdout
    }
    "reverse" => {
      let old = $"($tmp)/old.md"
      let new = $"($tmp)/new.md"
      fmt-copy $a.source $old
      fmt-copy $a.destination $new
      do { diff -u $old $new } | complete | get stdout
    }
    "blocked" => {
      $"# BLOCKED: ($a.repo_name)/($a.note_file) — ($a.reason)\n"
    }
  }

  rm -rf $tmp
  $result
}

def help-text [] {
  [
    "Sync markdown files between source repos and an Obsidian vault."
    ""
    "USAGE"
    "  mdup <command> [flags]"
    ""
    "COMMANDS"
    "  plan:     Compute a sync plan between org repos and the vault"
    "  apply:    Apply a previously generated sync plan"
    "  diff:     Show unified diffs for all changes in a plan"
    ""
    "CONFIG"
    "  Reads ~/.config/mdaemon.nuon by default:"
    "    { vault: \"~/code/notes\", orgs: [\"~/code/st0x\", \"~/code/other\"] }"
    ""
    "FLAGS"
    "  --help     Show help for command"
    "  --config   Override config file path"
    ""
    "EXAMPLES"
    "  $ mdup plan"
    "  $ mdup plan --org ~/code/st0x --vault ~/code/st0x/notes"
    "  $ mdup apply"
    "  $ mdup diff"
    ""
    "ENVIRONMENT"
    "  NU_LOG_LEVEL   Set to DEBUG for detailed file-by-file output (default: WARNING)"
    ""
    "LEARN MORE"
    "  Use `mdup <command> --help` for more information about a command."
  ] | str join "\n"
}

def plan-help-text [] {
  [
    "Compute a sync plan between org repos and the vault."
    ""
    "USAGE"
    "  mdup plan [--config <file>] [--org <path> --vault <path>] [--out <file>]"
    ""
    "FLAGS"
    "  --config <file>  Config file (default: ~/.config/mdaemon.nuon)"
    "  --org <path>     Single org root (overrides config)"
    "  --vault <path>   Vault path (overrides config)"
    "  --out <file>     Output plan file (default: ~/.config/.mdup-plan.nuon)"
    ""
    "With no flags, reads orgs and vault from the config file."
    "With --org and --vault, scans a single org (ignores config)."
    ""
    "ENVIRONMENT"
    "  NU_LOG_LEVEL=INFO     Show per-target scan progress"
    "  NU_LOG_LEVEL=DEBUG    Show per-file comparison details"
    ""
    "EXAMPLES"
    "  $ mdup plan"
    "  $ mdup plan --org ~/code/st0x --vault ~/code/notes"
    "  $ NU_LOG_LEVEL=DEBUG mdup plan"
  ] | str join "\n"
}

def apply-help-text [] {
  [
    "Apply a previously generated sync plan."
    ""
    "USAGE"
    "  mdup apply [--plan <file>] [--yes]"
    ""
    "FLAGS"
    "  --plan <file>   Path to plan file (default: ~/.config/.mdup-plan.nuon)"
    "  --yes, -y       Skip confirmation prompt"
    ""
    "EXAMPLES"
    "  $ mdup apply"
    "  $ mdup apply --plan ./my-plan.nuon"
    "  $ mdup apply --yes"
  ] | str join "\n"
}

def diff-help-text [] {
  [
    "Show unified diffs for all changes in a plan."
    ""
    "USAGE"
    "  mdup diff [--plan <file>] [--org <path> --vault <path>] [--config <file>]"
    ""
    "FLAGS"
    "  --plan <file>    Path to existing plan file"
    "  --org <path>     Single org root (overrides config)"
    "  --vault <path>   Vault path (overrides config)"
    "  --config <file>  Config file (default: ~/.config/mdaemon.nuon)"
    "  --stat           Show per-file summary only, no diffs"
    ""
    "Resolution order: --plan file > --org/--vault > plan file in cwd > config file."
    ""
    "EXAMPLES"
    "  $ mdup diff"
    "  $ mdup diff --plan ./my-plan.nuon"
    "  $ mdup diff --org ~/code/st0x --vault ~/code/notes"
  ] | str join "\n"
}
