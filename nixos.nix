{
  pkgs,
  lib,
  inputs,
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

  # The gateway's EnvironmentFile is a hard dependency: systemd fails the unit if
  # /var/lib/secrets/openclaw.env is missing. provision seeds it on first boot,
  # but a CD rebuild never re-seeds it, so guarantee both the dir and an (at
  # least empty) file exist at activation. `-` leaves a seeded file untouched.
  systemd.tmpfiles.rules = [
    "d /var/lib/secrets 0700 root root -"
    "f /var/lib/secrets/openclaw.env 0600 root root -"
  ];

  # OpenClaw — self-hosted personal agent, as a native systemd gateway service
  # (nix-openclaw module, imported in flake.nix). Reachable only over the tailnet
  # (no public port; the gateway binds locally and rides tailscale0).
  #
  # Model backends use existing SUBSCRIPTIONS, not paid APIs:
  #   - Cursor via the acpx ACP harness (cursor-agent) — the explicitly-permitted
  #     path; the default agent.
  #   - Claude Code CLI (claude-cli) as a text-only fallback.
  # Both CLIs are on the service PATH but must be logged in once on the box, and
  # the @openclaw/acpx plugin installed once (both are runtime, not declarative —
  # see README). openclaw.json is strict-validated, so this config stays minimal;
  # finalize routing with `/acp doctor` on the running gateway.
  services.openclaw-gateway = {
    enable = true;
    package = inputs.nix-openclaw.packages.x86_64-linux.openclaw;

    servicePath = [
      pkgs.cursor-cli # cursor-agent — Cursor subscription backend (ACP)
      pkgs.claude-code # claude — Claude subscription fallback (CLI backend)
    ];

    # Secrets (CURSOR_API_KEY, channel tokens) from the out-of-store file seeded
    # by `provision` / set via `nix run .#tfVars`.
    environmentFiles = [ "/var/lib/secrets/openclaw.env" ];

    # Deep-merged into /etc/openclaw/openclaw.json.
    config = {
      acp = {
        enabled = true;
        dispatch.enabled = true;
        backend = "acpx";
        defaultAgent = "cursor";
        allowedAgents = [
          "cursor"
          "claude"
        ];
      };

      plugins.entries.acpx.enabled = true;

      agents.defaults.cliBackends."claude-cli".command = "${pkgs.claude-code}/bin/claude";
    };
  };

  # The acpx plugin and CLI logins are one-time on-box runtime steps (see README),
  # so a freshly provisioned box runs the gateway before they are done. Cap the
  # restart rate so an unconfigured gateway backs off into a clean failed state
  # instead of hammering a tight crash-loop until setup is completed.
  systemd.services.openclaw-gateway = {
    startLimitIntervalSec = 300;
    startLimitBurst = 5;
    # The module ships RestartSec = 2 (tight loop); back it off so an
    # unconfigured gateway hits the start-limit and stops instead of hammering.
    serviceConfig.RestartSec = lib.mkForce 15;
  };

  # Set hostname
  networking.hostName = "nixxxos";

  system.stateVersion = "24.05";
}
