use std/assert

# The caller owns scratch-parent (a recorded project .tmp directory or Nix TMPDIR).
def main [scratch_parent: path] {
  let parent = ($scratch_parent | path expand)
  mkdir $parent
  let tests = ($env.CURRENT_FILE | path dirname)
  let root = (mktemp --directory --tmpdir-path $parent fj.XXXXXXXXXX)
  let result = (try {
    ^$nu.current-exe --no-config-file --no-history ($tests | path join routing.nu)
    assert equal $env.LAST_EXIT_CODE 0 "pure routing tests failed"
    ^$nu.current-exe --no-config-file --no-history ($tests | path join contract.nu) ($root | path join contract)
    assert equal $env.LAST_EXIT_CODE 0 "contract tests failed"
    ^$nu.current-exe --no-config-file --no-history ($tests | path join contract.nu) ($root | path join cli) --cli
    assert equal $env.LAST_EXIT_CODE 0 "CLI argv tests failed"
    ^$nu.current-exe --no-config-file --no-history ($tests | path join topology.nu) ($root | path join topology)
    assert equal $env.LAST_EXIT_CODE 0 "topology tests failed"
    {ok: true, message: ""}
  } catch {|e| {ok: false, message: $e.msg}})
  rm --recursive $root
  if not $result.ok { error make --unspanned {msg: $result.message} }
  print "PASS fj suite; invocation scratch removed"
}
