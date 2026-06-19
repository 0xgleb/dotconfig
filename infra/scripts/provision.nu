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
    #
    # Also re-mint the node auth key so a reprovision after Tailscale's 90-day
    # key expiry seeds a *fresh* key onto the box — otherwise stage-secrets would
    # write a dead key and the box (public SSH closed) never joins the tailnet.
    # The ci key is left alone here so a reprovision doesn't silently invalidate
    # the TS_AUTHKEY GitHub secret; refresh it on the documented 90-day cadence.
    let replace = [
      "-replace=digitalocean_droplet.nixxxos"
      "-replace=tailscale_tailnet_key.node"
    ]
    if $droplet_size == null {
      ^terraform apply ...$replace -var-file=terraform.tfvars -auto-approve
    } else {
      ^terraform apply ...$replace -var-file=terraform.tfvars -var $"droplet_size=($droplet_size)" -auto-approve
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

  wait-for-tailnet $id

  # The droplet was recreated, so its SSH host key changed. Clear any stale pin
  # for the tailnet name so the operator's next `ssh nixxxos` doesn't trip the
  # host-key-changed check (the probe above bypasses known_hosts, so it can't).
  do { ^ssh-keygen -R "nixxxos" } | complete | ignore

  print ""
  print "### Installed and joined the tailnet. ###"
  print "Access is tailnet-only (public SSH is closed). Reach it with:  ssh nixxxos"
  print "Cleared the stale host-key pin for `nixxxos`; if you also reach it by"
  print "tailnet IP, run `ssh-keygen -R <ip>` (find it with `tailscale status`)."
  print "OpenClaw model auth (cursor-agent login + acpx plugin) is a one-time on-box step — see the README."
}

# Confirm the box actually joined the tailnet and is reachable over it before
# declaring success. First-boot join can fail silently (dead/expired key,
# tailscaled crash, cloud-init networking race), and with public SSH closed an
# unconfirmed box is only recoverable via the DigitalOcean console — so fail
# loudly here instead of leaving the operator to discover it later.
def wait-for-tailnet [identity: string] {
  print "Waiting for nixxxos to join the tailnet (first boot ~1 min)..."

  # Reach the box by its MagicDNS name over the tailnet, bypassing known_hosts
  # (the freshly installed host key is new and would otherwise fail the check).
  let opts = [
    "-i" $identity
    "-o" "StrictHostKeyChecking=no"
    "-o" "UserKnownHostsFile=/dev/null"
    "-o" "ConnectTimeout=5"
  ]

  # ~5 min cap (60 * 5s) so a box that never joins fails instead of hanging.
  mut attempts = 0
  loop {
    let probe = (do { ^ssh ...$opts $"root@nixxxos" true } | complete)
    if $probe.exit_code == 0 { break }

    $attempts += 1
    if $attempts >= 60 {
      error make { msg: "nixxxos never came up on the tailnet — check tailscaled via the DigitalOcean console" }
    }

    sleep 5sec
  }
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

  # Create the secrets dir restricted from the start (mode 700) so the plaintext
  # auth key / env never sit in a world-traversable directory, even briefly,
  # before the chmod below.
  ^mkdir -p -m700 $secrets

  let tailscale_key = (^terraform output -raw tailscale_node_authkey | str trim)
  if ($tailscale_key | is-empty) {
    error make { msg: "terraform output tailscale_node_authkey is empty — did terraform apply succeed?" }
  }
  $tailscale_key | save -f ($secrets | path join "tailscale.authkey")

  # openclaw.env comes from the encrypted tfvars (var/output openclaw_env). When
  # it is empty we still write a template so the file exists; set openclaw_env
  # via `nix run .#tfVars` to seed the real secrets.
  let openclaw_env = (^terraform output -raw openclaw_env)
  let openclaw_content = if ($openclaw_env | str trim | is-empty) {
    [
      "# OpenClaw secrets, loaded by the gateway service (systemd EnvironmentFile)."
      "# Set openclaw_env in terraform.tfvars (nix run .#tfVars) to seed these."
      "# CURSOR_API_KEY=..."
      ""
    ] | str join "\n"
  } else {
    $openclaw_env
  }

  $openclaw_content | save -f ($secrets | path join "openclaw.env")

  ^chmod 700 $secrets
  ^chmod 600 ($secrets | path join "tailscale.authkey")
  ^chmod 600 ($secrets | path join "openclaw.env")

  $extra
}
