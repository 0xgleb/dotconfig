# `tf-destroy` — tear down the infra (droplet + Tailscale auth keys) so an idle
# box stops billing. Interactive: terraform prompts for confirmation (type yes);
# pass -auto-approve via the args to skip it.
# `with-infra` / `resolve-identity` come from lib.nu (concatenated at build).

def --wrapped main [--identity (-i): string, ...rest: string] {
  let id = (resolve-identity $identity)

  with-infra $id {
    ^terraform destroy -var-file=terraform.tfvars ...$rest
  }
}
