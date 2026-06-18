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

variable "tailscale_api_key" {
  type      = string
  sensitive = true
  # Create at https://login.tailscale.com/admin/settings/keys (API access token).
  # Note: Tailscale API keys expire after 90 days and must be rotated.
}

variable "tailscale_tailnet" {
  type    = string
  default = "-"
  # "-" means the default tailnet of the account that owns the API key.
}
