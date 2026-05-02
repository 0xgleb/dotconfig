{ pkgs, deploy-rs }:
let
  system = "x86_64-linux";
  inherit (deploy-rs.lib.${system}) activate;
  inherit (pkgs) tailscale;

  tailscaledUnit = pkgs.writeText "tailscaled.service" ''
    [Unit]
    Description=Tailscale node agent
    Documentation=https://tailscale.com/kb/
    Wants=network-online.target
    After=network-online.target

    [Service]
    ExecStart=${tailscale}/bin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=41641
    Restart=on-failure
    RuntimeDirectory=tailscale
    RuntimeDirectoryMode=0755
    StateDirectory=tailscale
    StateDirectoryMode=0700
    CacheDirectory=tailscale
    CacheDirectoryMode=0750
    Type=notify

    [Install]
    WantedBy=multi-user.target
  '';

  tailscaleActivate = builtins.concatStringsSep " && " [
    "install -D -m 0644 ${tailscaledUnit} /etc/systemd/system/tailscaled.service"
    "ln -sfn ${tailscale}/bin/tailscale /usr/local/bin/tailscale"
    "systemctl daemon-reload"
    "systemctl enable tailscaled.service"
    "systemctl restart tailscaled.service"
    "sleep 2"
    ''if [ -f /etc/tailscale/authkey ]; then ${tailscale}/bin/tailscale up --auth-key="$(cat /etc/tailscale/authkey)" --hostname=nixxxos && shred -u /etc/tailscale/authkey; fi''
  ];
in
{
  nodes.nixxxos.hostname = builtins.getEnv "DEPLOY_HOST";
  nodes.nixxxos.sshUser = "root";
  nodes.nixxxos.user = "root";
  nodes.nixxxos.profiles.tailscale.path = activate.custom tailscale tailscaleActivate;
}
