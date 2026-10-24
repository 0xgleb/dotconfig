use std/assert

use report-contract.nu [approval-matches delivery-verified render-report validate-report]

let evidence = [
  {id: "review:161", label: "rest.api #161", url: "https://github.com/example/api/pull/161", project: "API", reportable: true, attributable: true, current: true, countable: true}
  {id: "review:164", label: "rest.api #164", url: "https://github.com/example/api/pull/164", project: "API", reportable: true, attributable: true, current: true, countable: true}
  {id: "pr:208", label: "issuance #208", url: "https://github.com/example/service/pull/208", project: "Issuance", reportable: true, attributable: true, current: true, countable: true}
  {id: "pr:239", label: "issuance #239", url: "https://github.com/example/service/pull/239", project: "Issuance", reportable: true, attributable: true, current: true, countable: true}
  {id: "pr:254", label: "issuance #254", url: "https://github.com/example/service/pull/254", project: "Issuance", reportable: true, attributable: true, current: true, countable: true}
  {id: "batch:290", label: "issuance batch #290", url: "https://github.com/example/service/pull/290", project: "Issuance", reportable: true, attributable: true, current: true, countable: false}
  {id: "issue:1045", label: "issue #1045", url: "https://github.com/example/service/issues/1045", project: "Dividends", reportable: false, attributable: false, current: true, countable: false}
  {id: "issue:935", label: "issue #935", url: "https://github.com/example/service/issues/935", project: "Durable jobs", reportable: false, attributable: false, current: true, countable: false}
  {id: "deploy:rest-api", label: "rest.api deployment", url: "https://github.com/example/api/actions/runs/1", project: "Operations", reportable: false, attributable: false, current: true, countable: false}
  {id: "stale:prior-eod", label: "prior EOD item", url: "https://example.invalid/stale", project: "Prior", reportable: true, attributable: true, current: false, countable: false}
]

let report = {
  summary: "Review feedback and issuance changes were completed with exact supporting references."
  sections: [
    {
      heading: "Pull request reviews"
      items: [
        {text: "Requested changes on 2 API pull requests", count: 2, evidence_ids: ["review:161" "review:164"]}
      ]
    }
    {
      heading: "Issuance behavior"
      items: [
        {text: "Merged 3 issuance changes covering freeze scheduling and durable command handling", count: 3, evidence_ids: ["pr:208" "pr:239" "pr:254" "batch:290"]}
      ]
    }
  ]
}

def "test end to end exact approved payload verifies delivered outcome" [] {
  assert equal (validate-report $report $evidence) []
  let rendered = render-report $report $evidence

  assert ($rendered | str contains "## Pull request reviews")
  assert ($rendered | str contains "Requested changes on 2 API pull requests: [rest.api #161](https://github.com/example/api/pull/161)")
  assert ($rendered | str contains "Merged 3 issuance changes covering freeze scheduling and durable command handling")
  assert ($rendered | str contains "[issuance #254]")
  assert ($rendered | str contains "[issuance batch #290]")
  assert not ($rendered | str contains "issue #1045")
  assert not ($rendered | str contains "issue #935")
  assert not ($rendered | str contains "rest.api deployment")
  assert not ($rendered | str contains "prior EOD item")
  assert (approval-matches $rendered $rendered)
  assert not (delivery-verified $rendered $rendered "failed")
  assert (delivery-verified $rendered $rendered "delivered")
}

def "test report contract rejects irrelevant unattributable and stale claims" [] {
  let invalid = {
    summary: "Bad evidence promotion."
    sections: [{heading: "Operations", items: [{text: "Completed unrelated work", evidence_ids: ["issue:1045" "deploy:rest-api" "stale:prior-eod"]}]}]
  }
  let errors = validate-report $invalid $evidence | str join "\n"
  assert ($errors | str contains "issue:1045")
  assert ($errors | str contains "deploy:rest-api")
  assert ($errors | str contains "stale:prior-eod")
}

def "test report contract rejects generic and one-item project headings" [] {
  let generic = {
    summary: "Bad headings."
    sections: [
      {heading: "What Was Done", items: [{text: "Requested changes on 2 API pull requests", count: 2, evidence_ids: ["review:161" "review:164"]}]}
      {heading: "Issuance", items: [{text: "Merged 3 issuance changes", count: 3, evidence_ids: ["pr:208" "pr:239" "pr:254" "batch:290"]}]}
    ]
  }
  let errors = validate-report $generic $evidence | str join "\n"
  assert ($errors | str contains "section heading is generic")
  assert ($errors | str contains "one-item section heading is only a project name")
}

def "test every stated count matches adjacent countable references without counting the Graphite group" [] {
  let invalid = $report | update sections.1.items.0.count 4 | update sections.1.items.0.text "Merged 4 issuance changes"
  let errors = validate-report $invalid $evidence | str join "\n"
  assert ($errors | str contains "claim count 4 does not match 3 exact countable references")
}

def "test corrected payload requires exact fresh approval" [] {
  let approved = render-report $report $evidence
  let corrected = $approved | str replace "Review feedback" "Verified review feedback"
  assert not (approval-matches $approved $corrected)
  assert not (delivery-verified $approved $corrected "delivered")
}

def main [] {
  print "Running EOD report contract tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)
  let test_commands = ($tests
    | each {|test_name| $"($test_name); print '  ok ($test_name)'" }
    | str join "; ")
  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
