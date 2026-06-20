# `tf-apply` — terraform apply against the encrypted tfvars. Non-destructive: it
# does NOT recreate the droplet (unlike `provision`), so use it to roll out
# tailnet/DNS/key changes against the running box.
# `with-infra` / `resolve-identity` come from lib.nu (concatenated at build).

def --wrapped main [--identity (-i): string, ...rest: string] {
  let id = (resolve-identity $identity)

  with-infra $id {
    ^terraform apply -var-file=terraform.tfvars -auto-approve ...$rest
  }
}
