# `provision` — apply terraform, install NixOS via nixos-anywhere, and seed
# secrets so the box auto-joins the tailnet on first boot.
# `with-infra` / `resolve-identity` come from lib.nu (concatenated at build).

def main [--identity (-i): string, droplet_size?: string] {
  let id = (resolve-identity $identity)

  with-infra $id {
    # provision is a from-scratch install, so always recreate the droplet to
    # start from a clean image. nixos-anywhere wipes the disk anyway, and an
    # in-place resize of a half-installed box leaves it unbootable with no way to
    # retry. For non-destructive config changes use the CD deploy / nixos-rebuild
    # instead. The droplet size defaults to variables.tf; -var overrides it.
    let replace = "-replace=digitalocean_droplet.nixxxos"
    if $droplet_size == null {
      ^terraform apply $replace -var-file=terraform.tfvars -auto-approve
    } else {
      ^terraform apply $replace -var-file=terraform.tfvars -var $"droplet_size=($droplet_size)" -auto-approve
    }
  }

  cd $"($env.HOME)/.config/infra"

  let flake_dir = $"($env.HOME)/.config"
  let ip = (^terraform output -raw ip | str trim)

  wait-for-ssh $id $ip

  let extra = (stage-secrets)

  print "Installing NixOS..."

  # Guarantee the staged plaintext secrets are removed even if the install
  # aborts partway through, so a live auth key never lingers on disk.
  try {
    (^nix run github:nix-community/nixos-anywhere --
      --flake $"($flake_dir)#nixxxos"
      --ssh-option $"IdentityFile=($id)"
      --extra-files $extra
      --target-host $"root@($ip)")
  } catch {
    rm -rf $extra
    error make { msg: "nixos-anywhere install failed; staged secrets removed" }
  }

  rm -rf $extra

  let tailnet_ip = (wait-for-tailnet $id $ip)

  print $"Done! Tailnet IP: ($tailnet_ip)"
  print "Reach it with: ssh nixxxos   # MagicDNS, or use the tailnet IP above"
  print "Set the Hermes LLM key in /var/lib/secrets/hermes.env on the box, then redeploy."
}

# Wait until the freshly created droplet accepts SSH as root.
def wait-for-ssh [identity: string, ip: string] {
  print "Waiting for SSH..."

  # The pre-install host key is throwaway (nixos-anywhere regenerates it), so
  # bypass known_hosts — otherwise a re-provision against a reused IP whose key
  # changed would fail the host-key check on every probe and loop forever.
  let opts = [
    "-i" $identity
    "-o" "StrictHostKeyChecking=no"
    "-o" "UserKnownHostsFile=/dev/null"
  ]

  # ~5 min cap (150 * 2s) so a box that never comes up fails instead of hanging.
  mut attempts = 0
  loop {
    let probe = (
      do { ^ssh ...$opts -o ConnectTimeout=5 $"root@($ip)" true } | complete
    )

    if $probe.exit_code == 0 { break }

    $attempts += 1
    if $attempts >= 150 {
      error make { msg: $"timed out waiting for SSH on ($ip)" }
    }

    sleep 2sec
  }
}

# Build a directory tree that nixos-anywhere copies into the target root,
# seeding /var/lib/secrets before first boot. Returns its path.
def stage-secrets [] {
  let extra = (^mktemp -d | str trim)
  let secrets = ($extra | path join "var" "lib" "secrets")

  mkdir $secrets

  (^terraform output -raw tailscale_node_authkey
    | str trim
    | save -f ($secrets | path join "tailscale.authkey"))

  let hermes_env = [
    "# Hermes Agent secrets, merged into HERMES_HOME/.env at activation."
    "# Add your LLM provider key (and any messaging tokens), then redeploy."
    "# ANTHROPIC_API_KEY=sk-ant-..."
    ""
  ] | str join "\n"

  $hermes_env | save -f ($secrets | path join "hermes.env")

  ^chmod 700 $secrets
  ^chmod 600 ($secrets | path join "tailscale.authkey")
  ^chmod 600 ($secrets | path join "hermes.env")

  $extra
}

# Poll the box until tailscaled reports an address, then return it. The box
# regenerates host keys during install, so known_hosts is intentionally bypassed.
def wait-for-tailnet [identity: string, ip: string] {
  let opts = [
    "-i" $identity
    "-o" "StrictHostKeyChecking=no"
    "-o" "UserKnownHostsFile=/dev/null"
  ]

  print "Waiting for the box to join the tailnet..."

  # ~10 min cap (300 * 2s): install + reboot + tailnet join can take a while.
  mut attempts = 0
  loop {
    let probe = (
      do { ^ssh ...$opts -o ConnectTimeout=5 $"root@($ip)" "tailscale ip -4" } | complete
    )
    let addr = ($probe.stdout | str trim)

    if $probe.exit_code == 0 and $addr != "" {
      return $addr
    }

    $attempts += 1
    if $attempts >= 300 {
      error make { msg: $"timed out waiting for tailnet join on ($ip)" }
    }

    sleep 2sec
  }
}
