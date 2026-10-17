use std/assert
use ../routing.nu [fj-route vcs-backend resolve-stack protected-push-blocked]
use ../completions.nu [fj-complete]

# Selected pure contracts from dotconfig routing.test.nu; no launcher tests.
def main [] {
  assert equal (fj-route) {tool: status, args: []}
  assert equal (fj-route help) {tool: help, args: []}
  assert equal (fj-route ...[mut -a]) {tool: stack, args: [modify -a]}
  assert equal (fj-route push origin main) {tool: git, args: [push origin main]}
  assert equal (fj-route unknown) {tool: unknown, args: [unknown]}
  for managed in [true false] {
    for main in [true false] {
      assert equal (vcs-backend /synthetic/repo /synthetic $managed $main) (if $managed and $main { "but" } else { "git" })
    }
  }
  let mappings = [
    {verb: modify, but: [amend], git: [commit --amend]}
    {verb: ss, but: [push all], git: [push --force-with-lease]}
    {verb: submit, but: [push], git: [push]}
    {verb: sync, but: [pull], git: [pull]}
    {verb: co, but: [apply], git: [checkout]}
    {verb: checkout, but: [apply], git: [checkout]}
    {verb: create, but: [branch new], git: [checkout -b]}
    {verb: rename, but: [reword], git: [branch -m]}
  ]
  for entry in $mappings {
    for backend in [but git] {
      assert equal (resolve-stack {tool: stack, args: [$entry.verb "argument with spaces"]} $backend) {
        tool: $backend, args: (($entry | get $backend) | append "argument with spaces")
      }
    }
  }
  assert equal (resolve-stack {tool: stack, args: [up]} but) {tool: unsupported, args: [up but]}
  assert equal (resolve-stack {tool: stack, args: [squash]} git) {tool: unsupported, args: [squash git]}
  assert equal (resolve-stack {tool: stack, args: [ss]} unknown) {tool: unsupported, args: [ss unknown]}
  assert equal (resolve-stack {tool: git, args: [push]} but) {tool: git, args: [push]}
  for backend in [but git] {
    for branch in [main master] { assert (protected-push-blocked (fj-route ss) $backend $branch) }
    assert (not (protected-push-blocked (fj-route ss) $backend feature))
  }
  assert (not (protected-push-blocked (fj-route sync) git master))
  assert (not (protected-push-blocked (fj-route) git master))
  let empty = (try { resolve-stack {tool: stack, args: []} git; "no error" } catch {|e| $e.msg})
  assert ($empty | str contains "empty stack route") $empty
  assert equal (fj-complete | get completions.value) [help issue pr]
  for context in ["fj " "fj i" "mod p" "  fj\t"] {
    assert equal (fj-complete $context | get completions.value) [help issue pr] $context
  }
  for context in ["fj issue " "fj issue l" "fj pr " "fj pr v" "  mod\tpr\t"] {
    assert equal (fj-complete $context | get completions.value) [list view] $context
  }
  for context in ["fj issue list " "fj pr view 7 " "fj push " "fj help "] {
    assert equal (fj-complete $context | get completions) [] $context
  }
  print "PASS pure routing and completion contracts"
}
