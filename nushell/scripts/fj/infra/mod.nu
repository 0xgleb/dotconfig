def with-infra [action: closure] {
  cd ~/.config/infra
  if not (".terraform" | path exists) {
    ^terraform init
  }

  let identity = $"($env.HOME)/.ssh/nixxxos_ed25519"
  ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age

  let failed = (try { do $action; false } catch { true })
  rm -f terraform.tfvars
  if $failed { exit 1 }
}

def encrypt-vars [] {
  let keys_file = $"($env.HOME)/.config/keys.nix"
  let recipients = (^nix eval --raw --file $keys_file roles.infra --apply 'builtins.concatStringsSep "\n"')
  $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars
  rm -f terraform.tfvars
}

export def main [] {
  consequences
}

export def consequences [] {
  with-infra { ^terraform plan -var-file=terraform.tfvars }
}

export def enact [] {
  with-infra { ^terraform apply -var-file=terraform.tfvars }
}

export def "edit vars" [] {
  cd ~/.config/infra
  let identity = $"($env.HOME)/.ssh/nixxxos_ed25519"

  if ("terraform.tfvars.age" | path exists) {
    ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age
  } else {
    "" | save terraform.tfvars
  }

  let editor = ($env.EDITOR? | default "nvim")
  ^$editor terraform.tfvars

  encrypt-vars
}
