terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

resource "digitalocean_ssh_key" "nixxxos" {
  name       = "nixxxos"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "digitalocean_droplet" "nixxxos" {
  name     = "nixxxos"
  image    = "ubuntu-24-04-x64"
  size     = var.droplet_size
  region   = var.region
  ssh_keys = [digitalocean_ssh_key.nixxxos.fingerprint]

  lifecycle {
    ignore_changes = [image]
  }
}

output "ip" {
  value = digitalocean_droplet.nixxxos.ipv4_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/nixxxos_ed25519 root@${digitalocean_droplet.nixxxos.ipv4_address}"
}
