# mdup: terraform-like plan/apply for markdown vault sync
# Library functions are in sync-lib.nu and mdup-lib.nu (concatenated by nix at build time)

def "main plan" [
  --org: string
  --vault: string
  --out: string
] {
  if $org == null or $vault == null {
    print (plan-help-text)
    return
  }

  let org_root = ($org | path expand)
  let notes_root = ($vault | path expand)
  let plan_path = if $out != null { $out } else { ".mdup-plan.nuon" }

  let targets = (build-targets $org_root $notes_root)
  print $"org:    ($org_root)"
  print $"vault:  ($notes_root)"
  print $"targets: ($targets | length) \(($targets | get name | str join ', '))"
  print ""

  let actions = (compute-actions $targets $notes_root)

  let plan = {
    version: $PLAN_VERSION
    created_at: (date now | format date '%+')
    org: $org_root
    vault: $notes_root
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

def "main apply" [
  --plan: string
  --yes (-y)
] {
  let plan_path = if $plan != null { $plan } else { ".mdup-plan.nuon" }

  if not ($plan_path | path exists) {
    error make { msg: $"plan file not found: ($plan_path). Run `mdup plan` first." }
  }

  let plan = (open $plan_path)

  if $plan.version != $PLAN_VERSION {
    error make { msg: $"unsupported plan version: ($plan.version)" }
  }

  let actions = ($plan.actions | where action != "blocked")

  if ($actions | length) == 0 {
    print "No applicable actions in plan."
    return
  }

  print $"Plan from: ($plan.created_at)"
  print $"org:   ($plan.org)"
  print $"vault: ($plan.vault)"
  print $"($actions | length) action\(s) to apply"
  print ""

  # Verify all hashes still match (drift detection)
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
    print $"(ansi red)Drift detected! ($drifted | length) file\(s) changed since plan was created:(ansi reset)"
    $drifted | each {|a|
      print $"  ! ($a.repo_name)/($a.note_file)"
    }
    print ""
    print "Re-run `mdup plan` to generate a fresh plan."
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

def load-actions [--plan: string, --org: string, --vault: string] {
  if $org != null and $vault != null {
    let org_root = ($org | path expand)
    let notes_root = ($vault | path expand)
    let targets = (build-targets $org_root $notes_root)
    compute-actions $targets $notes_root
  } else {
    let plan_path = if $plan != null { $plan } else { ".mdup-plan.nuon" }

    if not ($plan_path | path exists) {
      error make { msg: $"plan file not found: ($plan_path). Run `mdup plan` first or pass --org/--vault." }
    }

    let loaded = (open $plan_path)

    if $loaded.version != $PLAN_VERSION {
      error make { msg: $"unsupported plan version: ($loaded.version)" }
    }

    $loaded.actions
  }
}

def print-summary [actions: list] {
  let creates = ($actions | where action == "create" | length)
  let forwards = ($actions | where action == "forward" | length)
  let reverses = ($actions | where action == "reverse" | length)
  let blocked = ($actions | where action == "blocked" | length)

  mut summary_parts = []
  if $creates > 0 { $summary_parts = ($summary_parts | append $"($creates) new") }
  if $forwards > 0 { $summary_parts = ($summary_parts | append $"($forwards) repo->vault") }
  if $reverses > 0 { $summary_parts = ($summary_parts | append $"($reverses) vault->repo") }
  if $blocked > 0 { $summary_parts = ($summary_parts | append $"(ansi red)($blocked) blocked(ansi reset)") }

  print $"($actions | length) changes \(($summary_parts | str join ', '))"
}

def "main diff" [
  --plan: string   # path to existing plan file
  --org: string    # organization root (computes plan on the fly)
  --vault: string  # notes vault path (computes plan on the fly)
  --stat           # show only per-file summary, no diffs
] {
  let actions = (load-actions --plan $plan --org $org --vault $vault)

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
  bat -l diff --style=plain --paging=auto $diff_file

  rm -rf $tmp

  print-summary $actions
}

def main [] {
  print (help-text)
}
