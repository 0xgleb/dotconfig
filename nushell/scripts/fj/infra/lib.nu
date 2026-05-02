# Pure helpers for terraform-driven infra workflows.
# Sourced by infra/default.nix wrappers (tf-plan, tf-vars, provision)
# and by infra/mod.nu (fj infra subcommands).

# Resolve SSH identity in priority order:
#   1. explicit --identity flag
#   2. $env.SSH_IDENTITY
#   3. $env.HOME/.ssh/id_ed25519 (if it exists)
def parse-identity [--identity (-i): string] {
  if ($identity | is-not-empty) {
    return $identity
  }
  if ($env.SSH_IDENTITY? | is-not-empty) {
    return $env.SSH_IDENTITY
  }
  let default = $"($env.HOME)/.ssh/id_ed25519"
  if ($default | path exists) {
    return $default
  }
  error make --unspanned {
    msg: "No identity found. Pass -i <path> or set SSH_IDENTITY."
  }
}

# Decrypt terraform.tfvars.age into terraform.tfvars in cwd.
# First-time setup: copy terraform.tfvars.example and open in $EDITOR.
def decrypt-vars [identity: string] {
  if ("terraform.tfvars.age" | path exists) {
    ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age
  } else if ("terraform.tfvars.example" | path exists) {
    cp terraform.tfvars.example terraform.tfvars
    let editor = ($env.EDITOR? | default "nvim")
    ^$editor terraform.tfvars
  } else {
    error make --unspanned {
      msg: "No terraform.tfvars.age or terraform.tfvars.example found."
    }
  }
}

# Encrypt terraform.tfvars to terraform.tfvars.age using recipients
# from $keys_file (a Nix file exposing roles.infra: list of public keys).
def encrypt-vars [keys_file: path] {
  if ("terraform.tfvars" | path exists) {
    let recipients = (
      ^nix eval --raw --file $keys_file roles.infra
        --apply 'builtins.concatStringsSep "\n"'
    )
    $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars
  }
}

def cleanup-vars [] {
  rm -f terraform.tfvars
}

# Read the authorized SSH public keys from keys.nix, returning them as a JSON
# string suitable for passing to `terraform -var authorized_keys=<json>`.
def authorized-keys [keys_file: path]: nothing -> string {
  ^nix eval --json --file $keys_file keys --apply 'builtins.attrValues'
}

# Run $action with terraform.tfvars decrypted in $infra_dir.
# Always re-encrypts and cleans up, even on failure.
def with-infra [
  identity: string
  keys_file: path
  infra_dir: path
  action: closure
] {
  cd $infra_dir
  if not (".terraform" | path exists) { ^terraform init }

  decrypt-vars $identity
  let failed = (try { do $action; false } catch { true })
  encrypt-vars $keys_file
  cleanup-vars
  if $failed { exit 1 }
}
