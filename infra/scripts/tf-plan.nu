# `tf-plan` — terraform plan against the encrypted tfvars.
# `with-infra` / `resolve-identity` come from lib.nu (concatenated at build).

def --wrapped main [--identity (-i): string, ...rest: string] {
  let id = (resolve-identity $identity)

  with-infra $id {
    ^terraform plan -var-file=terraform.tfvars ...$rest
  }
}
