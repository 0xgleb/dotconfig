terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.17"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

provider "tailscale" {
  api_key = var.tailscale_api_key
  tailnet = var.tailscale_tailnet
}

# Looks up an existing DigitalOcean SSH key by name — it must already exist in
# the DO account under exactly this name (Settings -> Security -> SSH keys), and
# its public half must match `dotconfig-nixos` in keys.nix. Renaming it (here or
# in DO) breaks `terraform apply` and locks provision out of the fresh droplet.
data "digitalocean_ssh_key" "dotconfig-nixos" {
  name = "dotconfig-nixos"
}

resource "digitalocean_droplet" "nixxxos" {
  name     = "nixxxos"
  image    = "ubuntu-24-04-x64"
  size     = var.droplet_size
  region   = var.region
  ssh_keys = [data.digitalocean_ssh_key.dotconfig-nixos.id]

  lifecycle {
    ignore_changes = [image]
  }
}

# Persistent node auth key for nixxxos. Reusable so re-provisioning works;
# not ephemeral so the box stays in the tailnet while offline.
# NOTE: this key expires after 90 days (provider default + tailnet max). Since
# the node is untagged, the *device* also keeps the tailnet's default 180-day
# key expiry — disable it in the admin console after first join (see README) so
# the box does not silently drop off the tailnet.
resource "tailscale_tailnet_key" "node" {
  reusable      = true
  ephemeral     = false
  preauthorized = true
  description   = "nixxxos node"
}

# Ephemeral, reusable key for GitHub Actions deploy runners. Ephemeral nodes
# are removed from the tailnet automatically after each CI run.
# NOTE: also expires after 90 days — re-mint (terraform apply) and refresh the
# TS_AUTHKEY GitHub secret on that cadence.
resource "tailscale_tailnet_key" "ci" {
  reusable      = true
  ephemeral     = true
  preauthorized = true
  description   = "github actions deploy"
}

# Enable MagicDNS tailnet-wide so `ssh nixxxos` resolves (the device's hostname
# becomes a *.ts.net name). Requires the Tailscale client to accept Tailscale DNS.
resource "tailscale_dns_preferences" "magic_dns" {
  magic_dns = true
}

output "ip" {
  value = digitalocean_droplet.nixxxos.ipv4_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/dotconfig-nixos root@${digitalocean_droplet.nixxxos.ipv4_address}"
}

# Consumed by the provision script and seeded onto the box at install time.
output "tailscale_node_authkey" {
  value     = tailscale_tailnet_key.node.key
  sensitive = true
}

# Consumed by the provision script to delete the previous nixxxos device from the
# tailnet before reinstall, so the new box does not collide on the MagicDNS name.
output "tailscale_api_key" {
  value     = var.tailscale_api_key
  sensitive = true
}

output "tailscale_tailnet" {
  value = var.tailscale_tailnet
}

# Copy into the GitHub Actions repository secret TS_AUTHKEY:
#   terraform -chdir=infra output -raw tailscale_ci_authkey
output "tailscale_ci_authkey" {
  value     = tailscale_tailnet_key.ci.key
  sensitive = true
}
