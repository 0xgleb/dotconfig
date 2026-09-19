use std/assert

# The fake executable is the external package boundary, not copied package code.
def stub [path: path, body: string] {
  [$"#!($nu.current-exe) --no-config-file" $body ""]
  | str join (char newline)
  | save $path
  ^chmod +x $path
}

def verify-consumer [fixture: path] {
  let source = ($env.CURRENT_FILE | path dirname)
  cp -r $source ($fixture | path join fj)
  ^chmod -R u+w ($fixture | path join fj)
  let package = ($fixture | path join portable)
  let bin = ($fixture | path join bin)
  let caller = ($fixture | path join "caller with spaces")
  mkdir ($package | path join bin) $bin $caller

  stub ($package | path join bin fj) 'def --wrapped main [...args: string] {
    if $args == [issue list --fail] { exit 29 }
    {provider: metagenda, args: $args, cwd: $env.PWD} | to json --raw
  }'
  stub ($bin | path join git) 'def --wrapped main [...args: string] {
    match $args {
      [rev-parse --abbrev-ref HEAD] => { print feature }
      [rev-parse --show-toplevel] => { print $env.PWD }
      [worktree list --porcelain] => { print $"worktree ($env.PWD)" }
      _ => { {provider: git, args: $args, cwd: $env.PWD} | to json --raw }
    }
  }'
  stub ($bin | path join gh) 'def --wrapped main [...args: string] {
    {provider: gh, args: $args, cwd: $env.PWD} | to json --raw
  }'

  let module = ($fixture | path join fj mod.nu)
  open --raw $module
  | str replace --all '@metagendaFj@' $package
  | save --force $module

  let cases = [
    {code: 'fj', provider: git, args: [status]}
    {code: 'fj issue list --state all --limit 2', provider: metagenda, args: [issue list --state all --limit "2"]}
    {code: 'fj issue view "42" --comments', provider: metagenda, args: [issue view "42" --comments]}
    {code: 'fj issue view "42" --web', provider: metagenda, args: [issue view "42" --web]}
    {code: 'fj pr list --search "two words; literal text"', provider: metagenda, args: [pr list --search "two words; literal text"]}
    {code: 'fj pr view', provider: metagenda, args: [pr view]}
    {code: 'fj pr view "feature/topic" --comments', provider: metagenda, args: [pr view feature/topic --comments]}
    {code: 'fj pr view --web --comments', provider: metagenda, args: [pr view --web --comments]}
    {code: 'fj add "file with spaces"', provider: git, args: [add "file with spaces"]}
    {code: 'fj pr create --draft', provider: gh, args: [pr create --draft]}
  ]

  with-env {PATH: ($env.PATH | prepend $bin), HOME: $fixture} {
    for case in $cases {
      let program = $"use ($fixture | path join fj | to nuon)\ncd ($caller | to nuon)\n($case.code)"
      let result = (do { ^nu --no-config-file --no-history --commands $program } | complete)
      assert equal $result.exit_code 0 $"($case.code): ($result.stderr)"
      assert equal ($result.stdout | from json) {
        provider: $case.provider
        args: $case.args
        cwd: $caller
      } $"consumer boundary: ($case.code)"
      print $"ok: ($case.code)"
    }

    let failed = (do {
      ^nu --no-config-file --no-history --commands $"use ($fixture | path join fj | to nuon)\nfj issue list --fail"
    } | complete)
    assert equal $failed.exit_code 29 "portable command failures must reach the caller"
    print "ok: portable failure propagation"

    let exports = (do {
      ^nu --no-config-file --no-history --commands $"use ($fixture | path join fj | to nuon)\nscope commands | get name | to json --raw"
    } | complete)
    assert equal $exports.exit_code 0 $exports.stderr
    let names = ($exports.stdout | from json)
    for name in ["fj clanker" "fj take" "fj check" "fj md sync" "fj infra provision" "fj cheatsheet"] {
      assert ($name in $names) $"local command lost: ($name)"
    }
    print "ok: local command exports preserved"
  }
}

def main [scratch: path] {
  let root = ($scratch | path expand)
  assert ($root | path exists) "pass an existing owned scratch directory"
  let fixture = ($root | path join $"consumer-(random uuid)")
  mkdir $fixture
  try {
    verify-consumer $fixture
  } catch {|failure|
    rm --recursive $fixture
    error make $failure
  }
  rm --recursive $fixture
}
