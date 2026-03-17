use std/log

const PLAN_VERSION = 1
const DEFAULT_REPOS = [liquidity issuance rest.api]

def file-hash [path: string] {
  open --raw $path | hash md5
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
      } else if (open --raw $source) != (open --raw $destination) {
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
          let stats = if $source_modified > $destination_modified {
            diff-stats $destination $source
          } else {
            diff-stats $source $destination
          }

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

def help-text [] {
  [
    "Sync markdown files between source repos and an Obsidian vault."
    ""
    "USAGE"
    "  mdup <command> [flags]"
    ""
    "COMMANDS"
    "  plan:    Compute a sync plan between org repos and the vault"
    "  apply:   Apply a previously generated sync plan"
    ""
    "FLAGS"
    "  --help   Show help for command"
    ""
    "EXAMPLES"
    "  $ mdup plan --org ~/code/st0x --vault ~/code/st0x/notes"
    "  $ mdup apply"
    "  $ mdup apply --plan ./my-plan.nuon --yes"
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
    "  mdup plan --org <path> --vault <path> [--out <file>]"
    ""
    "FLAGS"
    "  --org <path>     Organization root containing st0x.* repos"
    "  --vault <path>   Notes vault path"
    "  --out <file>     Output plan file (default: .mdup-plan.nuon)"
    ""
    "ENVIRONMENT"
    "  NU_LOG_LEVEL=INFO     Show per-target scan progress"
    "  NU_LOG_LEVEL=DEBUG    Show per-file comparison details"
    ""
    "EXAMPLES"
    "  $ mdup plan --org ~/code/st0x --vault ~/code/st0x/notes"
    "  $ NU_LOG_LEVEL=DEBUG mdup plan --org ~/code/st0x --vault ~/code/st0x/notes"
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
    "  --plan <file>   Path to plan file (default: .mdup-plan.nuon)"
    "  --yes, -y       Skip confirmation prompt"
    ""
    "EXAMPLES"
    "  $ mdup apply"
    "  $ mdup apply --plan ./my-plan.nuon"
    "  $ mdup apply --yes"
  ] | str join "\n"
}
