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
      (^terraform apply ...$replace -var-file=terraform.tfvars
        -var $"droplet_size=($droplet_size)" -auto-approve)
    }
  }

  cd $"($env.HOME)/.config/infra"

  let flake_dir = $"($env.HOME)/.config"
  let ip = (^terraform output -raw ip | str trim)

  # The droplet was recreated, so the previous nixxxos node is now dead. Remove
  # it from the tailnet before the new box first-boots and registers, or the
  # stale node keeps the `nixxxos` MagicDNS name (new box becomes `nixxxos-1`).
  remove-stale-device

  wait-for-ssh $id $ip

  let extra = (stage-secrets)

  print "Installing NixOS..."

  # Guarantee the staged plaintext secrets are removed even if the install
  # aborts partway through, so a live auth key never lingers on disk.
  try {
    (^nixos-anywhere
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
  print "### Install complete. ###"
  print "Access is tailnet-only (public SSH is closed). Reach it with:  ssh nixxxos"
  print "Cleared the stale host-key pin for `nixxxos`; if you also reach it by"
  print "tailnet IP, run `ssh-keygen -R <ip>` (find it with `tailscale status`)."
  print ("OpenClaw model auth (cursor-agent login + acpx plugin) is a one-time"
    + " on-box step — see the README.")
}

# Shared SSH options for probing the box: pin the identity and bypass
# known_hosts (the freshly installed/regenerated host key would otherwise fail).
def ssh-probe-opts [identity: string] {
  [
    "-i" $identity
    "-o" "StrictHostKeyChecking=no"
    "-o" "UserKnownHostsFile=/dev/null"
    "-o" "ConnectTimeout=5"
  ]
}

# Confirm the box actually joined the tailnet and is reachable over it before
# declaring success. First-boot join can fail silently (dead/expired key,
# tailscaled crash, cloud-init networking race), and with public SSH closed an
# unconfirmed box is only recoverable via the DigitalOcean console — so fail
# loudly here instead of leaving the operator to discover it later.
def wait-for-tailnet [identity: string] {
  print "Waiting for nixxxos to join the tailnet (first boot ~1 min)..."
  print "(this probes `ssh nixxxos` over the tailnet, so THIS machine must be on"
  print " the tailnet with MagicDNS for the check to pass)"

  # Reach the box by its MagicDNS name over the tailnet, bypassing known_hosts
  # (the freshly installed host key is new and would otherwise fail the check).
  let opts = (ssh-probe-opts $identity)

  # ~5 min cap (60 * 5s) so the probe doesn't hang forever.
  mut attempts = 0
  loop {
    let probe = (do { ^ssh ...$opts $"root@nixxxos" true } | complete)
    if $probe.exit_code == 0 {
      print "nixxxos is up on the tailnet."
      return
    }

    $attempts += 1
    if $attempts >= 60 {
      # Don't hard-fail: a timeout can mean the box failed to join OR that this
      # machine simply isn't on the tailnet — the install itself already
      # succeeded. Warn loudly and let the operator decide.
      print ""
      print "WARNING: could not reach nixxxos over the tailnet after ~5 min."
      print "  - If this machine is on the tailnet, the box likely failed to join"
      print "    — check tailscaled via the DigitalOcean console."
      print "  - If it is not, the box may be fine; confirm with `tailscale status`."
      return
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
  let opts = (ssh-probe-opts $identity)

  # ~5 min cap (150 * 2s) so a box that never comes up fails instead of hanging.
  mut attempts = 0
  loop {
    let probe = (do { ^ssh ...$opts $"root@($ip)" true } | complete)

    if $probe.exit_code == 0 { break }

    $attempts += 1
    if $attempts >= 150 {
      error make { msg: $"timed out waiting for SSH on ($ip)" }
    }

    sleep 2sec
  }
}

# Delete the previous nixxxos machine(s) from the tailnet so the freshly
# reinstalled box can claim the `nixxxos` MagicDNS name. Without this, both
# `ssh nixxxos` (wait-for-tailnet) and the CI `tailscale ip -4 nixxxos` lookup
# can resolve to the dead node or time out while the new box is healthy.
def remove-stale-device [] {
  # Cleanup is best-effort: any failure here (no API key, terraform/output error,
  # unexpected API envelope) prints a note and skips, never aborts the install.
  let api_key = (do { ^terraform output -raw tailscale_api_key } | complete)
  let key = ($api_key.stdout | str trim)
  if ($api_key.exit_code != 0 or ($key | is-empty)) {
    print "No Tailscale API key available; skipping stale-device cleanup."
    return
  }

  let tailnet_raw = (do { ^terraform output -raw tailscale_tailnet }
    | complete | get stdout | str trim)
  let tailnet = (if ($tailnet_raw | is-empty) { "-" } else { $tailnet_raw })
  let headers = { Authorization: $"Bearer ($key)" }

  let listed = (try {
    http get --headers $headers $"https://api.tailscale.com/api/v2/tailnet/($tailnet)/devices"
  } catch {
    print "Could not list tailnet devices; skipping stale-device cleanup."
    null
  })

  # Null-safe even if a 200 returns an unexpected shape without a `devices` key.
  let devices = ($listed | default {} | get devices? | default [])
  let stale = ($devices | where { |d| ($d.hostname? | default "") == "nixxxos" })
  for d in $stale {
    print $"Removing stale tailnet device ($d.name)..."
    # DELETE returns 200 with an empty body, which `http delete` would choke on
    # while parsing — go through `complete` and judge success by exit code.
    let url = $"https://api.tailscale.com/api/v2/device/($d.id)"
    let res = (do { http delete --headers $headers $url } | complete)
    if $res.exit_code != 0 {
      print $"  could not delete device ($d.id); continuing."
    }
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
    error make {
      msg: "terraform output tailscale_node_authkey is empty — did terraform apply succeed?"
    }
  }
  let authkey_path = ($secrets | path join "tailscale.authkey")
  $tailscale_key | save -f $authkey_path
  ^chmod 600 $authkey_path

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

  let openclaw_path = ($secrets | path join "openclaw.env")
  $openclaw_content | save -f $openclaw_path
  ^chmod 600 $openclaw_path

  $extra
}
