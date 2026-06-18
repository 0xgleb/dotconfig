# Shared helpers for the infra apps. infra/default.nix concatenates this ahead
# of each command script, so `with-infra` is in scope when nushell runs the
# packaged file.

# Decrypt terraform.tfvars, run an action with it present, then re-encrypt and
# remove the plaintext. On a fresh checkout (no .age yet) it seeds the file from
# the example and opens it in $EDITOR first.
def with-infra [identity: string, action: closure] {
  cd $"($env.HOME)/.config/infra"

  # Idempotent, and the only way newly added providers get installed.
  ^terraform init

  if not ("terraform.tfvars.age" | path exists) {
    cp terraform.tfvars.example terraform.tfvars

    let editor = ($env.EDITOR? | default "nvim")
    ^$editor terraform.tfvars
  } else {
    ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age
  }

  let recipients = (infra-recipients)
  let failed = (try { do $action; false } catch { true })

  $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars
  rm -f terraform.tfvars

  if $failed { exit 1 }
}

# The age recipients allowed to read infra secrets, newline-joined for rage.
def infra-recipients [] {
  let keys_file = $"($env.HOME)/.config/keys.nix"

  ^nix eval --raw --file $keys_file roles.infra --apply 'builtins.concatStringsSep "\n"'
}

# Default SSH identity used to reach the box, overridable with --identity.
def resolve-identity [identity: string] {
  $identity | default $"($env.HOME)/.ssh/id_ed25519"
}
