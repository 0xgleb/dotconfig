{ pkgs, ... }:
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

  # Hermes Agent (Nous Research) as a native systemd gateway service.
  # The package, user, hardening and config.yaml/.env wiring come from the
  # upstream nixosModule imported in flake.nix.
  services.hermes-agent = {
    enable = true;

    # Put the `hermes` CLI on PATH and share HERMES_HOME with the service so
    # interactive `hermes` sessions over SSH see the same state.
    addToSystemPackages = true;

    # Declarative config.yaml. The LLM provider/key is left out on purpose
    # (see environmentFiles); change the model to match the key you provide.
    settings = {
      model = "anthropic/claude-sonnet-4-6";
      terminal.backend = "local";
    };

    # Secrets (LLM API key, messaging tokens) are read from this out-of-store
    # file and merged into HERMES_HOME/.env at activation. The file is seeded
    # as a template by `provision`; populate it on the box, e.g.
    #   ANTHROPIC_API_KEY=sk-ant-...
    # then re-run a deploy (or `nixos-rebuild switch`) to apply.
    environmentFiles = [ "/var/lib/secrets/hermes.env" ];
  };

  # Set hostname
  networking.hostName = "nixxxos";

  system.stateVersion = "24.05";
}
