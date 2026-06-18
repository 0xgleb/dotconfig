# Run Mullvad as a raw WireGuard tunnel so it coexists with Tailscale.
#
# Two full-tunnel VPNs can't both hold the macOS default route, and Mullvad's
# app/CLI split tunnel only excludes app *binaries* — which can't carve out
# Tailscale's CGNAT range (its data path is a separate system extension), proven
# not to work. So we drive WireGuard directly with AllowedIPs = all traffic
# EXCEPT the tailnet (100.64.0.0/10 + fd7a:115c:a1e0::/48). Mullvad still tunnels
# everything else; tailnet packets skip it, so Tailscale stays reachable with
# Mullvad up.
#
# Setup (one-time): generate a Mullvad WireGuard config at
# https://mullvad.net/en/account/wireguard-config (new key, pick a server,
# download the .conf), then place it at /etc/wireguard/mullvad.conf as root:
#   sudo install -m600 -D ~/Downloads/<server>.conf /etc/wireguard/mullvad.conf
# It holds your private key, so it lives out-of-store (not in the flake). The
# launchd daemon below rewrites its AllowedIPs to the tailnet-excluding list and
# brings the tunnel up at boot. Until the file exists, this changes nothing.
# Don't also run the Mullvad GUI app — pick one.
#
# Rollback: remove /etc/wireguard/mullvad.conf and `darwin-rebuild switch` (or
# `sudo wg-quick down /var/run/mullvad-split.conf`).
{ pkgs, ... }:
let
  # 0.0.0.0/0 and ::/0 with Tailscale's 100.64.0.0/10 + fd7a:115c:a1e0::/48
  # subtracted (verified macOS recipe, not hand-computed).
  allowedIps = builtins.concatStringsSep ", " [
    "0.0.0.0/2"
    "64.0.0.0/3"
    "96.0.0.0/6"
    "100.0.0.0/10"
    "100.128.0.0/9"
    "101.0.0.0/8"
    "102.0.0.0/7"
    "104.0.0.0/5"
    "112.0.0.0/4"
    "128.0.0.0/1"
    "::/1"
    "8000::/2"
    "c000::/3"
    "e000::/4"
    "f000::/5"
    "f800::/6"
    "fc00::/8"
    "fd00::/10"
    "fd40::/11"
    "fd60::/12"
    "fd70::/13"
    "fd78::/15"
    "fd7a::/20"
    "fd7a:1000::/24"
    "fd7a:1100::/26"
    "fd7a:1140::/28"
    "fd7a:1150::/29"
    "fd7a:1158::/30"
    "fd7a:115c::/33"
    "fd7a:115c:8000::/35"
    "fd7a:115c:a000::/40"
    "fd7a:115c:a100::/41"
    "fd7a:115c:a180::/42"
    "fd7a:115c:a1c0::/43"
    "fd7a:115c:a1e1::/48"
    "fd7a:115c:a1e2::/47"
    "fd7a:115c:a1e4::/46"
    "fd7a:115c:a1e8::/45"
    "fd7a:115c:a1f0::/44"
    "fd7a:115c:a200::/39"
    "fd7a:115c:a400::/38"
    "fd7a:115c:a800::/37"
    "fd7a:115c:b000::/36"
    "fd7a:115c:c000::/34"
    "fd7a:115d::/32"
    "fd7a:115e::/31"
    "fd7a:1160::/27"
    "fd7a:1180::/25"
    "fd7a:1200::/23"
    "fd7a:1400::/22"
    "fd7a:1800::/21"
    "fd7a:2000::/19"
    "fd7a:4000::/18"
    "fd7a:8000::/17"
    "fd7b::/16"
    "fd7c::/14"
    "fd80::/9"
    "fe00::/7"
  ];

  # wg-quick on macOS needs wireguard-go (userspace tunnel) plus the system
  # networksetup/route tools.
  binPath = pkgs.lib.makeBinPath [
    pkgs.wireguard-tools
    pkgs.wireguard-go
    pkgs.gnugrep
    pkgs.coreutils
  ];
in
{
  environment.systemPackages = [ pkgs.wireguard-tools ];

  launchd.daemons.mullvad-wireguard = {
    serviceConfig = {
      RunAtLoad = true;
      StandardOutPath = "/var/log/mullvad-wireguard.log";
      StandardErrorPath = "/var/log/mullvad-wireguard.log";
    };
    script = ''
      set -eu
      export PATH=${binPath}:/usr/bin:/bin:/usr/sbin:/sbin

      conf=/etc/wireguard/mullvad.conf
      runtime=/var/run/mullvad-split.conf

      if [ ! -f "$conf" ]; then
        echo "mullvad-wireguard: $conf absent; leaving networking untouched."
        exit 0
      fi

      # Rebuild the config with AllowedIPs swapped for the tailnet-excluding set
      # (Mullvad's [Peer] is the last section, so appending stays in it).
      umask 077
      grep -v '^[[:space:]]*AllowedIPs' "$conf" > "$runtime"
      printf 'AllowedIPs = %s\n' "${allowedIps}" >> "$runtime"

      wg-quick down "$runtime" 2>/dev/null || true
      wg-quick up "$runtime"
    '';
  };
}
