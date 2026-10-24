const BANNED_HEADINGS = ["what was done" "review hardening"]

export def validate-report [report: record, evidence: list<record>]: nothing -> list<string> {
  let sections = $report.sections? | default []
  let project_names = ($evidence | get -o project | default [] | compact | each { into string | str lowercase } | uniq)
  let structural_errors = if (($report.summary? | default "" | str trim | is-empty)) {
    ["summary is empty"]
  } else if ($sections | is-empty) {
    ["report has no sections"]
  } else {
    []
  }

  let section_errors = ($sections | enumerate | each {|section_entry|
    let section = $section_entry.item
    let heading = $section.heading? | default "" | str trim
    let normalized = $heading | str lowercase
    let items = $section.items? | default []
    [
      (if ($heading | is-empty) { [$"section ($section_entry.index) heading is empty"] } else { [] })
      (if $normalized in $BANNED_HEADINGS { [$"section heading is generic: ($heading)"] } else { [] })
      (if (($items | length) == 1 and $normalized in $project_names) { [$"one-item section heading is only a project name: ($heading)"] } else { [] })
      (if ($items | is-empty) { [$"section ($heading) has no claims"] } else { [] })
    ] | flatten
  } | flatten)

  let claim_entries = ($sections | each {|section|
    $section.items? | default [] | each {|item| {heading: ($section.heading? | default ""), item: $item} }
  } | flatten)
  let claim_errors = ($claim_entries | enumerate | each {|claim_entry|
    let claim = $claim_entry.item.item
    let text = $claim.text? | default "" | str trim
    let evidence_ids = $claim.evidence_ids? | default []
    let resolved = ($evidence_ids | each {|id| $evidence | where id == $id | get -o 0 | default null })
    let missing = ($evidence_ids | zip $resolved | where {|pair| $pair.1 == null } | each {|pair| $pair.0 })
    let unsafe = ($resolved | compact | where {|item|
      (
        (not ($item.reportable? | default false))
        or (not ($item.attributable? | default false))
        or (not ($item.current? | default false))
      )
    } | get -o id | default [])
    let countable_refs = ($resolved | compact | where {|item| $item.countable? | default false } | get -o id | default [] | uniq)
    let expected_count = $claim.count? | default null
    let count_errors = if $expected_count == null {
      []
    } else if $expected_count != ($countable_refs | length) {
      [$"claim count ($expected_count) does not match ($countable_refs | length) exact countable references"]
    } else if not ($text | str contains ($expected_count | into string)) {
      [$"claim text does not contain its verified count ($expected_count)"]
    } else {
      []
    }
    [
      (if ($text | is-empty) { [$"claim ($claim_entry.index) text is empty"] } else { [] })
      (if ($evidence_ids | is-empty) { [$"claim ($claim_entry.index) has no evidence references"] } else { [] })
      ($missing | each {|id| $"claim references missing evidence ($id)" })
      ($unsafe | each {|id| $"claim references non-reportable, unattributable, or stale evidence ($id)" })
      $count_errors
    ] | flatten
  } | flatten)

  $structural_errors ++ $section_errors ++ $claim_errors
}

export def render-report [report: record, evidence: list<record>]: nothing -> string {
  let errors = validate-report $report $evidence
  if ($errors | is-not-empty) {
    error make {msg: ($errors | str join "; ")}
  }
  let sections = ($report.sections | each {|section|
    let items = ($section.items | each {|item|
      let references = ($item.evidence_ids | each {|id|
        let source = $evidence | where id == $id | get 0
        ["[" $source.label "](" $source.url ")"] | str join
      } | str join ", ")
      $"- ($item.text): ($references)"
    } | str join (char newline))
    $"## ($section.heading)\n\n($items)"
  } | str join "\n\n")
  $"($report.summary)\n\n($sections)\n"
}

export def approval-matches [approved: string, payload: string]: nothing -> bool {
  ($approved | str trim | is-not-empty) and $approved == $payload
}

export def delivery-verified [approved: string, payload: string, outcome: string]: nothing -> bool {
  (approval-matches $approved $payload) and $outcome == "delivered"
}
