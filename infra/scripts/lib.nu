# Shared helpers for the infra apps. infra/default.nix concatenates this ahead
# of each command script, so `with-infra` is in scope when nushell runs the
# packaged file.

# Decrypt terraform.tfvars, run an action with it present, then re-encrypt and
# remove the plaintext. On a fresh checkout (no .age yet) it seeds the file from
# the example and opens it in $EDITOR first.
def with-infra [identity: any, action: closure] {
  cd $"($env.HOME)/.config/infra"

  # Idempotent, and the only way newly added providers get installed.
  ^terraform init

  # Resolve recipients before any plaintext exists, so a failure here can't
  # strand a decrypted tfvars on disk.
  let recipients = (infra-recipients)

  # Everything that touches the plaintext runs inside the try so the rm below
  # always fires, on success or failure. The .age is re-written before the
  # action so freshly entered secrets survive an action failure.
  let failed = (try {
    if not ("terraform.tfvars.age" | path exists) {
      cp terraform.tfvars.example terraform.tfvars

      let editor = ($env.EDITOR? | default "nvim")
      ^$editor terraform.tfvars
    } else {
      ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age
    }

    $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars

    do $action
    false
  } catch {
    true
  })

  rm -f terraform.tfvars

  if $failed { exit 1 }
}

# The age recipients allowed to read infra secrets, newline-joined for rage.
def infra-recipients [] {
  let keys_file = $"($env.HOME)/.config/keys.nix"

  ^nix eval --raw --file $keys_file roles.infra --apply 'builtins.concatStringsSep "\n"'
}

# Default SSH identity used to reach the box, overridable with --identity.
# Defaults to the dotconfig-nixos key — the one Terraform actually authorizes on
# the droplet (main.tf installs only that DigitalOcean key), so a bare
# `nix run .#provision` connects instead of looping in wait-for-ssh.
# `any` (not `string`) so the null from an omitted --identity flag is accepted.
def resolve-identity [identity: any] {
  $identity | default $"($env.HOME)/.ssh/dotconfig-nixos"
}
