{
  pkgs,
  ...
}:
let
  authorizedKeys = (import ./keys.nix).authorized;
in
{
  nixpkgs.config.allowUnfree = true;

  users.users.root.openssh.authorizedKeys.keys = authorizedKeys;

  users.users."0xgleb" = {
    isNormalUser = true;
    home = "/home/0xgleb";
    shell = pkgs.nushell;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = authorizedKeys;
  };

  # Allow passwordless sudo for wheel group
  security.sudo.wheelNeedsPassword = false;

  # NixOS-specific packages
  environment.systemPackages = [ ];

  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "prohibit-password";
      PasswordAuthentication = false;
    };
  };

  # Tailscale. The node auth key is seeded out-of-store at install time by the
  # `provision` script (via nixos-anywhere --extra-files) so the box auto-joins
  # the tailnet on first boot. tailscaled persists its state in
  # /var/lib/tailscale, so later rebuilds stay joined even without the file.
  #
  # "client" lets the box use tailnet/subnet/exit-node routes without enabling
  # system-wide IP forwarding (which "server" would). Bump to "server" only if
  # this box should itself advertise routes or act as an exit node.
  services.tailscale = {
    enable = true;
    authKeyFile = "/var/lib/secrets/tailscale.authkey";
    useRoutingFeatures = "client";
  };

  # The node key is reusable (so re-provisioning works) and therefore does not
  # die on use — left on disk it is a standing credential that could register new
  # tailnet nodes if the disk is imaged or backed up. tailscaled-autoconnect runs
  # `tailscale up` and only completes once joined, and tailscaled then persists
  # its state in /var/lib/tailscale, so the file is dead weight afterwards.
  # Remove it once the daemon reports up.
  systemd.services.tailscale-authkey-cleanup = {
    description = "Remove the consumed Tailscale auth key once the node has joined";
    after = [ "tailscaled-autoconnect.service" ];
    requires = [ "tailscaled-autoconnect.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig.Type = "oneshot";
    script = ''
      # Only remove the key once tailscaled is up AND has persisted its node
      # state to disk. Otherwise a crash between join and the next async state
      # flush could leave the box with neither a key file nor recoverable state.
      # If state isn't flushed yet, leave the key — a later activation cleans it.
      if ${pkgs.tailscale}/bin/tailscale status >/dev/null 2>&1 \
        && [ -s /var/lib/tailscale/tailscaled.state ]; then
        rm -f /var/lib/secrets/tailscale.authkey
      fi
    '';
  };

  networking.firewall = {
    # No public ports. SSH (and anything else) is reachable only over the
    # tailnet via the trusted tailscale0 interface; the public interface is
    # closed. That is the whole point of running Tailscale.
    allowedTCPPorts = [ ];
    trustedInterfaces = [ "tailscale0" ];
    # Loose reverse-path filtering avoids asymmetric tailnet traffic being
    # silently dropped (also what the tailscale module sets for "client").
    checkReversePath = "loose";
  };

  # /var/lib/secrets holds the out-of-store Tailscale node auth key that
  # `provision` seeds at install time (services.tailscale.authKeyFile above).
  # Guarantee the dir exists (mode 700) at activation so a rebuild never races a
  # missing parent.
  systemd.tmpfiles.rules = [
    "d /var/lib/secrets 0700 root root -"
  ];

  # Set hostname
  networking.hostName = "nixxxos";

  system.stateVersion = "24.05";
}
