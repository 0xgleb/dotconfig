{ pkgs, ... }:
let
  keys = (import ./keys.nix).keys;
  authorizedKeys = builtins.attrValues keys;
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

  services.tailscale.enable = true;

  systemd.services.tailscale-autoconnect = {
    description = "Automatic Tailscale connection";
    after = [
      "network-online.target"
      "tailscaled.service"
    ];
    wants = [
      "network-online.target"
      "tailscaled.service"
    ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      Restart = "on-failure";
      RestartSec = 5;
    };
    path = [ pkgs.tailscale ];
    script = ''
      authkey="/etc/tailscale/authkey"
      [ -f "$authkey" ] || exit 0

      tailscale up --auth-key "$(cat "$authkey")" --hostname=nixxxos
      rm -f "$authkey"
    '';
  };

  networking.firewall = {
    allowedTCPPorts = [ 22 ];
    trustedInterfaces = [ "tailscale0" ];
  };

  # Set hostname
  networking.hostName = "nixxxos";

  system.stateVersion = "24.05";
}
