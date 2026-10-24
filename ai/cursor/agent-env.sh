#!/usr/bin/env bash

# Canonical PATH for Cursor agent shells and other non-login bash invocations.
# Keep this aligned with home.sessionPath in home.nix.
export PATH="${HOME}/.nix-profile/bin:/run/current-system/sw/bin:/etc/profiles/per-user/${USER}/bin:/nix/var/nix/profiles/default/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"
