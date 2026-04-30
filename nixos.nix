{ pkgs, ... }:
{
  nixpkgs.config.allowUnfree = true;

  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8m2M/93ymq8JIG/cDvNhXnHDrI7mzSjKhZBLTgdKXe nixxxos"
  ];

  users.users."0xgleb" = {
    isNormalUser = true;
    home = "/home/0xgleb";
    shell = pkgs.nushell;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8m2M/93ymq8JIG/cDvNhXnHDrI7mzSjKhZBLTgdKXe nixxxos"
    ];
  };

  # Allow passwordless sudo for wheel group
  security.sudo.wheelNeedsPassword = false;

  # NixOS-specific packages
  environment.systemPackages = with pkgs; [ emacs-nox ];

  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "prohibit-password";
      PasswordAuthentication = false;
    };
  };

  services.tailscale.enable = true;

  networking.firewall = {
    allowedTCPPorts = [ 22 ];
    trustedInterfaces = [ "tailscale0" ];
  };

  # Set hostname
  networking.hostName = "nixxxos";

  system.stateVersion = "24.05";
}
