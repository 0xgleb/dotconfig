use std/assert

# Run only inside a caller-created, isolated scratch directory. No real gh/But.
def main [root: path, --cli] {
  let root = ($root | path expand)
  let module = ($env.CURRENT_FILE | path dirname | path dirname | path join mod.nu)
  let nu_exe = $nu.current-exe
  mkdir ($root | path join bin) ($root | path join home)
  let calls = ($root | path join calls.jsonl)
  let fixture = (open --raw ($env.CURRENT_FILE | path dirname | path join fake-tool.nu))
  for tool in [git but gh] {
    let target = ($root | path join bin $tool)
    $"#!($nu_exe) --no-config-file\n($fixture)" | save $target
    ^chmod +x $target
    assert equal $env.LAST_EXIT_CODE 0
  }
  mkdir ($root | path join no-but)
  cp ($root | path join bin git) ($root | path join no-but git)
  let response = ($root | path join response.json)
  {
    number: 7, title: "Synthetic item", body: "Example body", author: {login: "reader"},
    state: "OPEN", labels: [{name: "test"}], createdAt: "2026-01-01T00:00:00Z",
    isDraft: false, headRefName: "feature", baseRefName: "main", additions: 2,
    deletions: 1, changedFiles: 1, latestReviews: []
  } | to json | save $response
  let cases = [
    {name: "reject mutation", args: [push origin main], scenario: normal, branch: main, linked: false, ok: false, text: "not included", tool: none}
    {name: "reject tracker mutation", args: [issue create], scenario: normal, branch: main, linked: false, ok: false, text: "not included", tool: none}
    {name: "help needs no tools", args: [help], scenario: normal, branch: main, linked: false, ok: true, text: "fj", tool: none}
    {name: "plain status", args: [], scenario: normal, branch: main, linked: false, ok: true, text: GIT_STATUS, tool: git}
    {name: "managed status", args: [], scenario: normal, branch: "gitbutler/workspace", linked: false, ok: true, text: BUT_STATUS, tool: but}
    {name: "linked stays git", args: [], scenario: normal, branch: "gitbutler/linked", linked: true, ok: true, text: GIT_STATUS, tool: git}
    {name: "git failure", args: [], scenario: git-fail, branch: main, linked: false, ok: false, text: "discovery failed", tool: git}
    {name: "bad topology", args: [], scenario: bad-topology, branch: main, linked: false, ok: false, text: "topology", tool: git}
    {name: "truncated topology", args: [], scenario: truncated-topology, branch: "gitbutler/workspace", linked: false, ok: false, text: "topology", tool: git}
    {name: "unlisted topology", args: [], scenario: unlisted-topology, branch: "gitbutler/linked", linked: true, ok: false, text: "topology", tool: git}
    {name: "missing But", args: [], scenario: missing-but, branch: "gitbutler/workspace", linked: false, ok: false, text: "but", tool: git}
    {name: "no But fallback", args: [], scenario: but-fail, branch: "gitbutler/workspace", linked: false, ok: false, text: "but status failed", tool: but}
    {name: "issue format", args: [issue view "7"], scenario: normal, branch: main, linked: false, ok: true, text: "# Synthetic item", tool: gh, expected: [issue view "7" --json], json: true}
    {name: "current PR", args: [pr view], scenario: normal, branch: main, linked: false, ok: true, text: "pr: #7", tool: gh, expected: [pr view --json], json: true}
    {name: "list flags", args: [issue list --repo example/project --limit "3"], scenario: normal, branch: main, linked: false, ok: true, text: GH_PASSTHROUGH, tool: gh, expected: [issue list --repo example/project --limit "3"]}
    {name: "comments", args: [pr view --comments], scenario: normal, branch: main, linked: false, ok: true, text: GH_PASSTHROUGH, tool: gh, expected: [pr view --comments]}
    {name: "web precedence", args: [issue view "7" --comments --web], scenario: normal, branch: main, linked: false, ok: true, text: GH_PASSTHROUGH, tool: gh, expected: [issue view "7" --web]}
    {name: "failed valid JSON", args: [issue view "7"], scenario: gh-fail, branch: main, linked: false, ok: false, text: "tracker failed", tool: gh, expected: [issue view "7" --json], json: true}
    {name: "bad JSON", args: [pr view], scenario: bad-json, branch: main, linked: false, ok: false, text: "", tool: gh, expected: [pr view --json], json: true}
    {name: "bad shape", args: [pr view], scenario: bad-shape, branch: main, linked: false, ok: false, text: "", tool: gh, expected: [pr view --json], json: true}
    {name: "invalid number", args: [issue view "7"], scenario: invalid-number, branch: main, linked: false, ok: false, text: "invalid tracker", tool: gh, expected: [issue view "7" --json], json: true}
    {name: "invalid review", args: [pr view], scenario: bad-review, branch: main, linked: false, ok: false, text: "invalid tracker review", tool: gh, expected: [pr view --json], json: true}
    {name: "invalid author", args: [pr view], scenario: bad-author, branch: main, linked: false, ok: false, text: "invalid tracker author", tool: gh, expected: [pr view --json], json: true}
    {name: "null authors", args: [pr view], scenario: null-author, branch: main, linked: false, ok: true, text: "unknown", tool: gh, expected: [pr view --json], json: true}
    {name: "failed PR JSON", args: [pr view], scenario: gh-fail, branch: main, linked: false, ok: false, text: "tracker failed", tool: gh, expected: [pr view --json], json: true}
    {name: "failed list", args: [pr list], scenario: gh-fail, branch: main, linked: false, ok: false, text: "tracker failed", tool: gh, expected: [pr list]}
    {name: "failed comments", args: [pr view --comments], scenario: gh-fail, branch: main, linked: false, ok: false, text: "tracker failed", tool: gh, expected: [pr view --comments]}
    {name: "failed web", args: [pr view --web], scenario: gh-fail, branch: main, linked: false, ok: false, text: "tracker failed", tool: gh, expected: [pr view --web]}
  ]
  let invalid_topologies = ([extra-nul no-head bad-head duplicate-head no-branch bad-branch duplicate-branch duplicate-worktree detached-branch duplicate-detached bare-current bare-head duplicate-path] | each {|scenario|
    {name: $scenario, args: [], scenario: $scenario, branch: "gitbutler/workspace", linked: false, ok: false, text: "topology", tool: git}
  })
  let cases = ($cases | append $invalid_topologies | append [
    {name: "duplicate bare marker", args: [], scenario: duplicate-bare, branch: "gitbutler/linked", linked: true, ok: false, text: "topology", tool: git}
    {name: "sha256 HEAD", args: [], scenario: sha256, branch: main, linked: false, ok: true, text: GIT_STATUS, tool: git}
    {name: "detached record", args: [], scenario: detached, branch: main, linked: false, ok: true, text: GIT_STATUS, tool: git}
    {name: "bare main with linked checkout", args: [], scenario: bare-main, branch: "gitbutler/linked", linked: true, ok: true, text: GIT_STATUS, tool: git}
  ])
  for case in $cases {
    "" | save --force $calls
    # File import has a stable namespace even when Nix unpacks into 'source'.
    let command = $"use ($module | to nuon)\nmod ...($case.args | to nuon)"
    let result = (with-env {
      HOME: ($root | path join home), XDG_CONFIG_HOME: ($root | path join home),
      PATH: [(if $case.scenario == "missing-but" { $root | path join no-but } else { $root | path join bin })], FJ_CALLS: $calls, FJ_RESPONSE: $response,
      FJ_SCENARIO: $case.scenario, FJ_TOP: ($root | path join "repo with spaces"),
      FJ_MAIN: (if $case.linked { $root | path join other } else { $root | path join "repo with spaces" }),
      FJ_BRANCH: $case.branch
    } {
      if $cli {
        do { ^$nu_exe --no-config-file --no-history ($module | path dirname | path join cli.nu) ...$case.args } | complete
      } else {
        do { ^$nu_exe --no-config-file --no-history --commands $command } | complete
      }
    })
    assert equal ($result.exit_code == 0) $case.ok $"($case.name): ($result.stderr)"
    if not $case.ok and "view" in $case.args and "--comments" not-in $case.args and "--web" not-in $case.args {
      assert equal $result.stdout "" $"failed view rendered output: ($case.name)"
    }
    let output = if $case.ok { $result.stdout } else { $result.stderr }
    assert ($output | str contains $case.text) $"($case.name): ($output)"
    let invoked = (open --raw $calls | lines | where {|s| $s != ""} | each {|s| $s | from json})
    if $case.tool == "none" { assert ($invoked | is-empty) $case.name } else {
      assert equal ($invoked | last | get tool) $case.tool $case.name
      assert ($invoked | all {|call| $call.cwd == $env.PWD}) $"caller cwd changed: ($case.name)"
      if $case.tool == "git" {
        assert (not ($invoked | any {|call| $call.tool == "but"}))
        if not $case.ok {
          assert (not ($invoked | any {|call| $call.args == [status]})) "invalid discovery invoked status"
        }
      }
    }
    if $case.tool == "gh" {
      assert equal ($invoked | length) 1 $case.name
      let actual = ($invoked | last | get args)
      if $case.json? == true {
        # The formatter owns the field list, but not the route or omitted ID.
        assert equal ($actual | first ($case.expected | length)) $case.expected $case.name
        assert equal ($actual | length) (($case.expected | length) + 1) $case.name
      } else {
        assert equal $actual $case.expected $case.name
      }
    }
    print $"PASS ($case.name)"
  }
  print $"Passed ($cases | length) contract cases"
}
