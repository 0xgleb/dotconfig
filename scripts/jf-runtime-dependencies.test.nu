use std/assert

let evaluated = (do {
  ^nix --accept-flake-config eval --no-write-lock-file --raw '.#packages.aarch64-darwin.jf.drvPath'
} | complete)
assert equal $evaluated.exit_code 0

let references = (do {
  ^nix-store --query --references ($evaluated.stdout | str trim)
} | complete)
assert equal $references.exit_code 0

let obsolete = (
  $references.stdout
  | lines
  | where {|path| $path | str contains 'graphite-cli' }
)
assert equal ($obsolete | length) 0
print 'jf runtime dependencies: no retired Graphite backend'
