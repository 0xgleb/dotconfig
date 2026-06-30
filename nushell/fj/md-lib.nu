use std/log
use md-sync-lib.nu *

const PLAN_VERSION = 1
const DEFAULT_CONFIG_PATH = "~/.config/mdaemon.nuon"
const DEFAULT_PLAN_PATH = "~/.config/.mdup-plan.nuon"

def file-hash [path: string] {
  open --raw $path | hash md5
}

def fmt-content [path: string] {
  let tmp = (mktemp --suffix .md)
  cp $path $tmp
  try { do { ^deno fmt --quiet $tmp } | complete } catch {}
  let content = (open --raw $tmp)
  rm -f $tmp
  $content
}

def fmt-copy [source: string, dest: string] {
  cp $source $dest
  try { do { ^deno fmt --quiet $dest } | complete } catch {}
}

export def compute-actions [targets: table<name: string, path: string>, notes_root: string] {
  $targets | each {|target|
    if not ($target.path | path exists) {
      log warning $"($target.name): path ($target.path) does not exist, skipping"
      return []
    }

    let repo_notes = $"($notes_root)/($target.name)"
    let files = (md-files $target.path)
    log info $"($target.name): ($target.path) -> ($files | length) md file\(s)"

    # Skip files whose note paths collide (note-file is not injective): planning
    # both would create two actions for one destination. Surface, don't clobber.
    let collisions = (note-collisions $files)
    let colliding_notes = ($collisions | get note)
    for c in $collisions {
      log warning ($"($target.name): note-path collision -- "
        + $"(($c.files) | str join ', ') all map to '($c.note)'; skipping all.")
    }
    let safe_files = ($files | where {|file| (note-file $file) not-in $colliding_notes })

    $safe_files | each {|file|
      let note_file = (note-file $file)
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
        let src = (ls -l $source | first)
        let dst = (ls -l $destination | first)
        let forward = $src.modified > $dst.modified
        let label = $"($target.name)/($note_file)"

        let newer = if $forward { $src } else { $dst }
        let older = if $forward { $dst } else { $src }
        let newer_size = ($newer.size | into int)
        let older_size = ($older.size | into int)

        if $newer_size == 0 and $older_size > 0 {
          log warning $"($label): blocked -- empty file would overwrite non-empty"
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
          if $forward {
            fmt-copy $destination $fmt_old
            fmt-copy $source $fmt_new
          } else {
            fmt-copy $source $fmt_old
            fmt-copy $destination $fmt_new
          }
          let stats = (diff-stats $fmt_old $fmt_new)
          rm -rf $tmp

          let direction = if $forward { "forward" } else { "reverse" }
          let arrow = if $forward { "repo -> vault" } else { "vault -> repo" }
          log debug $"($label): changed \(($arrow), +($stats.adds) -($stats.dels))"

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

export def format-action [a: record] {
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

export def action-diff [a: record] {
  let tmp = (mktemp -d)

  let result = match $a.action {
    "create" => {
      let formatted = $"($tmp)/new.md"
      fmt-copy $a.source $formatted
      do { ^diff -u /dev/null $formatted } | complete | get stdout
    }
    "forward" => {
      let old = $"($tmp)/old.md"
      let new = $"($tmp)/new.md"
      fmt-copy $a.destination $old
      fmt-copy $a.source $new
      do { ^diff -u $old $new } | complete | get stdout
    }
    "reverse" => {
      let old = $"($tmp)/old.md"
      let new = $"($tmp)/new.md"
      fmt-copy $a.source $old
      fmt-copy $a.destination $new
      do { ^diff -u $old $new } | complete | get stdout
    }
    "blocked" => {
      $"# BLOCKED: ($a.repo_name)/($a.note_file) — ($a.reason)\n"
    }
  }

  rm -rf $tmp
  $result
}

export def print-summary [actions: list] {
  let creates = ($actions | where action == "create" | length)
  let forwards = ($actions | where action == "forward" | length)
  let reverses = ($actions | where action == "reverse" | length)
  let blocked = ($actions | where action == "blocked" | length)

  let parts = [
    { n: $creates, text: $"($creates) new" }
    { n: $forwards, text: $"($forwards) repo->vault" }
    { n: $reverses, text: $"($reverses) vault->repo" }
    { n: $blocked, text: $"(ansi red)($blocked) blocked(ansi reset)" }
  ]
  let summary_parts = ($parts | where n > 0 | get text)

  print $"($actions | length) changes \(($summary_parts | str join ', '))"
}

export def resolve-targets [--org: string, --vault: string, --config: string] {
  if $org != null and $vault != null {
    let org_root = ($org | path expand)
    let notes_root = ($vault | path expand)
    let targets = (build-targets $org_root $notes_root)
    { vault: $notes_root, targets: $targets, orgs: [$org_root] }
  } else {
    let config_path = if $config != null { $config } else { $DEFAULT_CONFIG_PATH }
    let cfg = (load-config $config_path)
    let targets = (build-all-targets $cfg)
    { vault: $cfg.vault, targets: $targets, orgs: $cfg.orgs }
  }
}

# Open a plan file, verifying it exists and matches the supported version.
def load-plan [plan_path: string] {
  if not ($plan_path | path exists) {
    error make { msg: $"plan file not found: ($plan_path). Run `fj md plan` first." }
  }
  let loaded = (open $plan_path)
  if $loaded.version != $PLAN_VERSION {
    error make { msg: $"unsupported plan version: ($loaded.version)" }
  }
  $loaded
}

export def load-actions [--plan: string, --org: string, --vault: string, --config: string] {
  if $org != null and $vault != null {
    let resolved = (resolve-targets --org $org --vault $vault)
    compute-actions $resolved.targets $resolved.vault
  } else if $plan != null or (($DEFAULT_PLAN_PATH | path expand) | path exists) {
    let plan_path = if $plan != null { $plan } else { ($DEFAULT_PLAN_PATH | path expand) }
    (load-plan $plan_path).actions
  } else {
    let resolved = (resolve-targets --config $config)
    compute-actions $resolved.targets $resolved.vault
  }
}

export def run-plan [--org: string, --vault: string, --config: string, --out: string] {
  let resolved = (resolve-targets --org $org --vault $vault --config $config)
  let notes_root = $resolved.vault
  let targets = $resolved.targets
  let plan_path = if $out != null { $out } else { ($DEFAULT_PLAN_PATH | path expand) }

  print $"vault:   ($notes_root)"
  print $"orgs:    ($resolved.orgs | each {|o| $o | path basename } | str join ', ')"
  print $"targets: ($targets | length) \(($targets | get name | str join ', '))"
  print ""

  let actions = (compute-actions $targets $notes_root)

  let plan = {
    version: $PLAN_VERSION
    created_at: (date now | format date '%+')
    vault: $notes_root
    orgs: $resolved.orgs
    actions: $actions
  }

  $plan | to nuon --indent 2 | save --force $plan_path

  if ($actions | length) == 0 {
    print "No changes detected. Vault is up to date."
    return
  }

  $actions | each {|a| print (format-action $a) }
  print ""
  print-summary $actions
  print $"Plan saved to: ($plan_path)"
}

export def run-diff [--plan: string, --org: string, --vault: string, --config: string, --stat] {
  let actions = (load-actions --plan $plan --org $org --vault $vault --config $config)

  if ($actions | length) == 0 {
    print "No changes. Vault is up to date."
    return
  }

  if $stat {
    $actions | each {|a| print (format-action $a) }
    print ""
    print-summary $actions
    return
  }

  let tmp = (mktemp -d)
  let diff_file = $"($tmp)/diff.patch"

  let parts = ($actions | each {|a|
    let header = (format-action $a)
    let diff_text = (action-diff $a)
    $"($header)\n($diff_text)"
  })

  $parts | str join "\n" | save --force $diff_file
  ^bat -l diff --style=plain --paging=auto $diff_file

  rm -rf $tmp

  print-summary $actions
}

export def run-apply [--plan: string, --yes (-y)] {
  let plan_path = if $plan != null { $plan } else { ($DEFAULT_PLAN_PATH | path expand) }
  let plan = (load-plan $plan_path)
  let actions = ($plan.actions | where action != "blocked")

  if ($actions | length) == 0 {
    print "No applicable actions in plan."
    return
  }

  print $"Plan from: ($plan.created_at)"
  print $"vault: ($plan.vault)"
  print $"($actions | length) action\(s) to apply"
  print ""

  let drifted = ($actions | each {|a|
    let source_ok = if ($a.source | path exists) {
      (file-hash $a.source) == $a.source_hash
    } else {
      $a.action != "reverse"
    }

    let dest_ok = if $a.destination_hash == null {
      not ($a.destination | path exists)
    } else if ($a.destination | path exists) {
      (file-hash $a.destination) == $a.destination_hash
    } else {
      false
    }

    if (not $source_ok) or (not $dest_ok) {
      $a
    } else {
      null
    }
  } | compact)

  if ($drifted | length) > 0 {
    let n = ($drifted | length)
    let msg = $"Drift detected! ($n) file\(s) changed since plan was created:"
    print $"(ansi red)($msg)(ansi reset)"
    $drifted | each {|a|
      print $"  ! ($a.repo_name)/($a.note_file)"
    }
    print ""
    print "Re-run `fj md plan` to generate a fresh plan."
    error make { msg: "plan is stale, aborting" }
  }

  if not $yes {
    print -n $"Apply ($actions | length) change\(s)? [y/N] "
    let event = (input listen --types [key])
    let key = if $event.key_type == "char" { $event.code } else { "" }
    print $key
    if ($key | str downcase) != "y" {
      print "Aborted."
      return
    }
  }

  let results = ($actions | each {|action|
    let label = $"($action.repo_name)/($action.note_file)"
    try {
      match $action.action {
        "create" => {
          mkdir ($action.destination | path dirname)
          atomic-cp $action.source $action.destination
          print $"  (ansi green)+(ansi reset) ($label)"
        }
        "forward" => {
          mkdir ($action.destination | path dirname)
          atomic-cp $action.source $action.destination
          let arrow = "repo -> vault"
          print $"  (ansi yellow)~(ansi reset) ($label) ($arrow)"
        }
        "reverse" => {
          mkdir ($action.source | path dirname)
          atomic-cp $action.destination $action.source
          let arrow = "vault -> repo"
          print $"  (ansi cyan)~(ansi reset) ($label) ($arrow)"
        }
      }
      "ok"
    } catch {|e|
      let detail = if ($e | get -o rendered? | is-not-empty) {
        $e.rendered
      } else {
        $e.msg
      }
      print -e $"  (ansi red)ERROR(ansi reset) ($label):"
      print -e $"    ($detail)"
      print -e $"    source: ($action.source)"
      print -e $"    destination: ($action.destination)"
      "error"
    }
  })

  let applied = ($results | where $it == "ok" | length)
  let error_count = ($results | where $it == "error" | length)

  print ""
  print $"Applied: ($applied), Errors: ($error_count)"

  if $error_count == 0 {
    rm $plan_path
    print "Plan file cleaned up."
  } else {
    print "Plan file kept due to errors. Fix issues and re-run apply."
  }
}
