# `tf-destroy` — tear down the infra (droplet + Tailscale auth keys) so an idle
# box stops billing. Interactive: terraform prompts for confirmation (type yes);
# pass -auto-approve via the args to skip it.
# `with-infra` / `resolve-identity` come from lib.nu (concatenated at build).

def --wrapped main [--identity (-i): string, ...rest: string] {
  tf-run $identity "destroy" ...$rest
}
