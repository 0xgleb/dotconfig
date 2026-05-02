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

data "digitalocean_ssh_key" "doop" {
  name = "doop"
}

resource "digitalocean_droplet" "nixxxos" {
  name     = "nixxxos"
  image    = "ubuntu-24-04-x64"
  size     = var.droplet_size
  region   = var.region
  ssh_keys = [data.digitalocean_ssh_key.doop.id]

  lifecycle {
    ignore_changes = [image]
  }
}

output "ip" {
  value = digitalocean_droplet.nixxxos.ipv4_address
}

output "ssh_command" {
  value = "ssh -i ~/.ssh/doop root@${digitalocean_droplet.nixxxos.ipv4_address}"
}
