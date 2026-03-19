#!/usr/bin/env nu

# Dev runner: execute mdup directly from source without nix build.
# Usage: nu mdaemon/dev-mdup.nu plan --org ~/code/st0x --vault ~/code/st0x/notes
# Usage: nu mdaemon/dev-mdup.nu diff
# Usage: nu mdaemon/dev-mdup.nu apply

def main [...rest: string] {
  let script_dir = ($env.CURRENT_FILE | path dirname)
  let assembled = (
    (open --raw $"($script_dir)/sync-lib.nu")
    + "\n"
    + (open --raw $"($script_dir)/mdup-lib.nu")
    + "\n"
    + (open --raw $"($script_dir)/mdup.nu")
  )
  let tmp = (mktemp --suffix .nu)
  $assembled | save --force $tmp
  try {
    ^nu $tmp ...$rest
  } catch {|e|
    rm -f $tmp
    error make { msg: $e.msg }
  }
  rm -f $tmp
}
