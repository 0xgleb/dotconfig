variable "droplet_size" {
  type    = string
  default = "s-2vcpu-4gb"
  # s-1vcpu-1gb: $6/mo — minimal
  # s-2vcpu-4gb: $24/mo — dev work
  # s-4vcpu-8gb: $48/mo — heavier work
}

variable "region" {
  type    = string
  default = "nyc1"
  # nyc1, nyc3, sfo3, lon1, ams3, fra1
}

variable "do_token" {
  type      = string
  sensitive = true
}

variable "authorized_keys" {
  type        = list(string)
  description = "SSH public keys allowed to log in as root. Sourced from keys.nix at apply time."
}
