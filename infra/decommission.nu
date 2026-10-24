# `decommission` — tear down the nixxxos box: `terraform destroy` (droplet +
# Tailscale auth keys), then drop the local stale host-key pin. The inverse of
# `provision`. Interactive by default (terraform prompts `yes`); pass
# `-auto-approve` to skip. The SSH identity defaults to the dotconfig-nixos key
# (resolve-identity), matching provision — destroy itself does not SSH, but the
# default keeps the two commands symmetric.
# `with-infra` / `resolve-identity` / `tf-run` come from lib.nu (concatenated at
# build).

def --wrapped main [--identity (-i): string, ...rest: string] {
  tf-run $identity "destroy" ...$rest

  # The box is gone; drop the local `nixxxos` host-key pin so a future box that
  # reuses the name doesn't trip the host-key-changed check on first connect.
  do { ^ssh-keygen -R "nixxxos" } | complete | ignore

  print ""
  print "nixxxos decommissioned. Its tailnet device (now dead) is cleared on the"
  print "next `nix run .#provision`, or remove it from the Tailscale admin console."
}
