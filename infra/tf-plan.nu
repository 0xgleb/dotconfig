# `tf-plan` — terraform plan against the encrypted tfvars.
# `with-infra` / `resolve-identity` come from lib.nu (concatenated at build).

def --wrapped main [--identity (-i): string, ...rest: string] {
  tf-run $identity "plan" ...$rest
}
