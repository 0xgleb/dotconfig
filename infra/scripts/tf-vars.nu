# `tf-vars` — decrypt, edit, and re-encrypt terraform.tfvars.
# `resolve-identity` / `infra-recipients` come from lib.nu (concatenated at build).

def main [--identity (-i): string] {
  cd $"($env.HOME)/.config/infra"

  let id = (resolve-identity $identity)

  if not ("terraform.tfvars.age" | path exists) {
    cp terraform.tfvars.example terraform.tfvars
  } else {
    ^rage -d -i $id -o terraform.tfvars terraform.tfvars.age
  }

  let editor = ($env.EDITOR? | default "nvim")
  ^$editor terraform.tfvars

  let recipients = (infra-recipients)

  $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars
  rm -f terraform.tfvars
}
