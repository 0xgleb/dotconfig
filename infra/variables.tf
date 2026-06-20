variable "droplet_size" {
  type    = string
  default = "s-2vcpu-4gb"
  # OpenClaw is substituted from the garnix cache, so the box no longer builds a
  # heavy closure on install — 4GB is fine again. Bump if the agent needs more
  # runtime headroom (cursor-agent can be memory-hungry under load).
  # s-2vcpu-4gb:  $24/mo — default (gateway + agent)
  # s-4vcpu-8gb:  $48/mo — runtime headroom
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

variable "openclaw_env" {
  type      = string
  sensitive = true
  default   = ""
  # Contents of /var/lib/secrets/openclaw.env on the box: the Cursor key plus any
  # channel tokens, e.g. "CURSOR_API_KEY=...". Use a heredoc for multiple lines.
  # Seeded by `provision`; empty leaves a fill-in-later template.
}
