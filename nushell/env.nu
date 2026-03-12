# Environment setup -- loaded before config.nu
# https://www.nushell.sh/book/configuration.html#environment

# PATH in nushell is a list, not a colon-separated string.
# `char esep` is the platform's env separator (: on unix, ; on windows)
# split row turns the string into a list, prepend adds to the front
# https://www.nushell.sh/book/configuration.html#path-configuration
$env.PATH = ($env.PATH | split row (char esep) | prepend '/opt/homebrew/bin')

$env.EDITOR = 'vim'
