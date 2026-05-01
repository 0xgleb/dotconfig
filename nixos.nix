{ pkgs, inputs, ... }:
let
  unstable = import inputs.nixpkgs-unstable {
    system = "x86_64-linux";
    config.allowUnfree = true;
  };
in
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
    linger = true;
  };

  security.sudo.wheelNeedsPassword = false;

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
    allowedTCPPorts = [ ];
    trustedInterfaces = [ "tailscale0" ];
  };

  networking.hostName = "nixxxos";

  systemd.services.claude-remote-control = {
    description = "Claude Code remote control server";
    after = [
      "network-online.target"
      "tailscaled.service"
    ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      User = "0xgleb";
      Group = "users";
      ExecStart = "${unstable.claude-code}/bin/claude remote-control --name nixxxos --spawn worktree";
      Restart = "on-failure";
      RestartSec = 10;
      WorkingDirectory = "/home/0xgleb";
    };
  };

  system.stateVersion = "24.05";
}
