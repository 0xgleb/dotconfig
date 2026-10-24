use mod.nu

# argv remains data; module resolution never changes the caller's cwd.
def --wrapped main [...args: string] { mod ...$args }
