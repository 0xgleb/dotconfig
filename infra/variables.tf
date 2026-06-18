variable "droplet_size" {
  type    = string
  default = "s-4vcpu-8gb"
  # s-1vcpu-1gb:  $6/mo  — minimal
  # s-2vcpu-4gb:  $24/mo — dev work, but OOMs building the Hermes closure
  # s-4vcpu-8gb:  $48/mo — enough RAM to build Hermes during install
  # s-8vcpu-16gb: $96/mo — headroom if 8gb still OOMs on the build
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

variable "hermes_env" {
  type      = string
  sensitive = true
  default   = ""
  # Contents of /var/lib/secrets/hermes.env on the box: the LLM API key (and any
  # messaging tokens), e.g. "ANTHROPIC_API_KEY=sk-ant-...". Use a heredoc for
  # multiple lines. Seeded by `provision`; empty leaves a fill-in-later template.
}
