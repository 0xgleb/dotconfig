# Environment setup -- loaded before config.nu
# https://www.nushell.sh/book/configuration.html#environment

# PATH in nushell is a list, not a colon-separated string.
# `char esep` is the platform's env separator (: on unix, ; on windows)
# split row turns the string into a list, prepend adds to the front
# https://www.nushell.sh/book/configuration.html#path-configuration
$env.PATH = ($env.PATH | split row (char esep) | append [
  '/run/current-system/sw/bin'
  '/etc/profiles/per-user/0xgleb/bin'
  $'($env.HOME)/.nix-profile/bin'
  '/nix/var/nix/profiles/default/bin'
  '/opt/homebrew/bin'
  '/usr/local/bin'
])

$env.EDITOR = 'nvim'

const NU_LIB_DIRS = [($nu.home-dir | path join ".config" "nushell")]
