use std/assert

def git-ok [args: list<string>] {
  let result = (do { ^git ...$args } | complete)
  assert equal $result.exit_code 0 $result.stderr
  $result.stdout
}

# Real Git repositories entirely inside caller-owned scratch; But is inert.
def main [root: path] {
  let root = ($root | path expand)
  let module = ($env.CURRENT_FILE | path dirname | path dirname | path join mod.nu)
  let nu_exe = $nu.current-exe
  mkdir ($root | path join bin) ($root | path join home) ($root | path join "main repo")
  let spy = ($root | path join bin but)
  $"#!($nu_exe) --no-config-file\ndef main [...args: string] { print 'SYNTHETIC_BUT' }\n" | save $spy
  ^chmod +x $spy
  assert equal $env.LAST_EXIT_CODE 0
  with-env {
    HOME: ($root | path join home), XDG_CONFIG_HOME: ($root | path join home),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
    PATH: ($env.PATH | prepend ($root | path join bin))
  } {
    # Do not let inherited Git routing variables redirect fixture writes.
    hide-env --ignore-errors GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_TEMPLATE_DIR GIT_NAMESPACE GIT_SHALLOW_FILE GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM
    cd ($root | path join "main repo")
    git-ok [init --initial-branch=gitbutler/workspace] | ignore
    git-ok [config user.name Synthetic] | ignore
    git-ok [config user.email synthetic@example.invalid] | ignore
    git-ok [config core.hooksPath /dev/null] | ignore
    git-ok [commit --allow-empty -m fixture] | ignore
    let linked = ($env.PWD | path join .tmp worktrees secondary)
    git-ok [worktree add -b gitbutler/linked $linked] | ignore
    let command = $"use ($module | to nuon)\nmod"
    let main_result = (do { ^$nu_exe --no-config-file --no-history --commands $command } | complete)
    assert equal $main_result.exit_code 0 $main_result.stderr
    assert ($main_result.stdout | str contains SYNTHETIC_BUT)
    do {
      cd $linked
      let result = (do { ^$nu_exe --no-config-file --no-history --commands $command } | complete)
      assert equal $result.exit_code 0 $result.stderr
      assert (not ($result.stdout | str contains SYNTHETIC_BUT))
      assert ($result.stdout | str contains "gitbutler/linked")
    }
    git-ok [checkout --detach] | ignore
    let detached = (do { ^$nu_exe --no-config-file --no-history --commands $command } | complete)
    assert equal $detached.exit_code 0 $detached.stderr
    assert (not ($detached.stdout | str contains SYNTHETIC_BUT))
    # Whole root is disposed by run.nu even when any assertion fails.
  }
  print "PASS real main/linked/detached topology with spaces"
}
