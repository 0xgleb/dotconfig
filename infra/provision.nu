# `provision` — stand up the nixxxos box and connect: terraform apply (create if
# absent, never -replace), install NixOS via nixos-anywhere on a fresh box, seed
# secrets so it auto-joins the tailnet, then SSH in over the tailnet and attach
# the `nixxxos` zellij session. An existing box is left intact — tear it down
# with `nix run .#decommission` to rebuild, or update it via the CD deploy.
# `with-infra` / `resolve-identity` come from lib.nu (concatenated at build).

def main [--identity (-i): string, droplet_size?: string] {
  let id = (resolve-identity $identity)

  cd $"($env.HOME)/.config/infra"

  # provision is non-destructive: stand up a NEW box only when one isn't already
  # in terraform state. The apply below runs WITHOUT -replace, so an existing
  # droplet is never recreated and its disk / tailnet state survive. To rebuild
  # from scratch, `nix run .#decommission` first; to change an existing box, use
  # the CD deploy / nixos-rebuild. (A fresh box mints a fresh node auth key on
  # create, so the old -replace re-mint is unnecessary.)
  let preexisting = (provision-preexisting)

  with-infra $id {
    if $droplet_size == null {
      ^terraform apply -var-file=terraform.tfvars -auto-approve
    } else {
      (^terraform apply -var-file=terraform.tfvars
        -var $"droplet_size=($droplet_size)" -auto-approve)
    }

    # Fresh install only: clear the previous `nixxxos` tailnet device now, while
    # terraform.tfvars is decrypted (the Tailscale admin key is read from there,
    # kept out of tfstate). Otherwise the new box registers as `nixxxos-1`.
    if not $preexisting {
      remove-stale-device
    }
  }

  if $preexisting {
    print ""
    print "nixxxos already exists in terraform state — leaving it intact and"
    print "skipping the destructive reinstall. `nix run .#decommission` to rebuild,"
    print "or use the CD deploy to update it in place."
  } else {
    let flake_dir = $"($env.HOME)/.config"
    let ip = (^terraform output -raw ip | str trim)

    wait-for-ssh $id $ip

    let extra = (stage-secrets)

    print "Installing NixOS..."

    # Remove the staged plaintext secrets even if the install aborts partway, so
    # a live auth key never lingers on disk.
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

    # Fresh box, new SSH host key — clear any stale pin so the attach below (and a
    # later `ssh nixxxos`) doesn't trip the host-key-changed check.
    do { ^ssh-keygen -R "nixxxos" } | complete | ignore

    print ""
    print "### Install complete. ###"
    print "Access is tailnet-only (public SSH is closed)."
    print ("On the box, run `claude /login` once (claude.ai account) so `fj clanker`"
      + " there launches with remote control.")
  }

  # Connect: attach the `nixxxos` zellij session over the tailnet — but only once
  # the box is actually reachable, so an unjoined box prints a hint instead of
  # hanging on a dead SSH.
  if (wait-for-tailnet $id) {
    attach-nixxxos $id
  } else {
    print ""
    print "Skipping auto-connect — nixxxos isn't reachable over the tailnet yet."
    print "Once it's up:  ssh -i ~/.ssh/dotconfig-nixos -t root@nixxxos zellij attach -c nixxxos"
  }
}

# Decide whether a nixxxos droplet already exists, erring hard toward "yes" so a
# flaky state query can never authorize the destructive reinstall below.
#
# A fresh checkout has no local state file at all; `nix run .#decommission`
# leaves an empty-but-present state. An existing box's state file is present even
# when `terraform state list` fails transiently (held lock, corrupted state,
# version-upgrade prompt). So: no state file => no box; state file present but the
# query fails => abort rather than wipe a live box on an indeterminate answer.
def provision-preexisting [] {
  # terraform's local backend writes terraform.tfstate in this dir; its absence
  # means nothing has ever been applied here, so there is no box.
  if not ("terraform.tfstate" | path exists) {
    return false
  }

  let probe = (do { ^terraform state list } | complete)
  if $probe.exit_code != 0 {
    error make {
      msg: ($"`terraform state list` failed \(exit ($probe.exit_code)) but a state"
        + " file is present — refusing to provision, since falling through could"
        + " wipe a live droplet. Resolve the terraform state error and retry."
        + $"\n($probe.stderr)")
    }
  }

  $probe.stdout | lines | any {|r| $r == "digitalocean_droplet.nixxxos" }
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
      return true
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
      return false
    }

    sleep 5sec
  }
}

# Open an interactive SSH session over the tailnet and attach (creating if
# needed) the `nixxxos` zellij session. Public SSH is closed, so this rides the
# tailnet MagicDNS name; -t gives zellij a TTY, and accept-new pins the box's
# fresh host key without a prompt (the install cleared any stale pin first).
# zellij is a system package on the box, so it is on root's PATH.
def attach-nixxxos [identity: string] {
  print ""
  print "Connecting to nixxxos (zellij session `nixxxos`)..."
  (^ssh
    "-i" $identity
    "-o" "StrictHostKeyChecking=accept-new"
    "-t" "root@nixxxos"
    "zellij" "attach" "-c" "nixxxos")
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
# Read a scalar value from the decrypted terraform.tfvars (present only inside a
# with-infra block). tfvars here is flat `name = "value"` lines, so a
# line-oriented parse suffices. Returns "" when the key is absent or commented.
def tfvar [name: string]: nothing -> string {
  if not ("terraform.tfvars" | path exists) { return "" }

  # Single-quoted regex body is literal (no nushell interpolation), so the
  # capture group survives; $name is a fixed identifier with no regex specials.
  let pattern = ('^' + $name + '\s*=\s*"?(?<val>[^"]*)"?\s*$')

  open --raw terraform.tfvars
  | lines
  | each {|l| $l | str trim }
  | where {|l| not ($l | str starts-with "#") }
  | parse --regex $pattern
  | get val?
  | get 0?
  | default ""
  | str trim
}

def remove-stale-device [] {
  # Cleanup is best-effort: any failure here (no API key, unexpected API
  # envelope) prints a note and skips, never aborts the install. The Tailscale
  # admin key is read from the decrypted tfvars (this runs inside with-infra),
  # NOT from tfstate, so the long-lived admin credential never lands in the
  # plaintext state file.
  let key = (tfvar "tailscale_api_key")
  if ($key | is-empty) {
    print "No Tailscale API key in tfvars; skipping stale-device cleanup."
    return
  }

  let tailnet_raw = (tfvar "tailscale_tailnet")
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
    # `complete` only works on external commands; `http delete` is built-in, so
    # judge success with try/catch (best-effort cleanup — any failure just skips).
    # An empty 200 body is fine here; a non-2xx status raises and is caught.
    let url = $"https://api.tailscale.com/api/v2/device/($d.id)"
    let ok = (try { http delete --headers $headers $url; true } catch { false })
    if not $ok {
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

  $extra
}
