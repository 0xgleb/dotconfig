{ pkgs }:
let
  inherit (pkgs) lib;

  writeNushellApplication =
    {
      name,
      text,
      runtimeInputs ? [ ],
    }:
    let
      script = pkgs.writeTextFile {
        inherit name;
        executable = true;
        destination = "/bin/${name}";
        text = "#!${pkgs.nushell}/bin/nu\n${text}";
      };
    in
    if runtimeInputs == [ ] then
      script
    else
      pkgs.symlinkJoin {
        inherit name;
        paths = [ script ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/${name} \
            --prefix PATH : ${lib.makeBinPath runtimeInputs}
        '';
      };

  infraInputs = [
    pkgs.terraform
    pkgs.rage
  ];

  keysFile = ../keys.nix;
  libFile = ../nushell/scripts/fj/infra/lib.nu;
  infraDir = ''$"($env.HOME)/.config/infra"'';

  provisionInner = writeNushellApplication {
    name = "provision-inner";
    runtimeInputs = infraInputs ++ [ pkgs.openssh ];
    text = ''
      source ${libFile}

      def main [--identity (-i): string, droplet_size: string = "s-2vcpu-4gb"] {
        let id = (parse-identity -i $identity)
        with-infra $id ${keysFile} ${infraDir} {
          ^terraform apply -var-file=terraform.tfvars -var $"droplet_size=($droplet_size)" -auto-approve
        }

        cd ${infraDir}
        let ip = (do { ^terraform output -raw ip } | complete)
        if $ip.exit_code != 0 or ($ip.stdout | str trim | is-empty) {
          print "No droplet IP found — nothing to provision."
          return
        }
        let ip = ($ip.stdout | str trim)

        print $"Waiting for SSH at ($ip)..."
        loop {
          let result = (do { ^ssh -i $id -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new $"root@($ip)" true } | complete)
          if $result.exit_code == 0 { break }
          sleep 2sec
        }

        # secretspec exposes TS_AUTHKEY as a file path (as_path = true).
        # Empty when the secret isn't configured (required = false).
        let ts_authkey_path = ($env.TS_AUTHKEY? | default "")
        let extra_files = if ($ts_authkey_path | is-not-empty) and ($ts_authkey_path | path exists) {
          let tmpdir = (mktemp -d)
          mkdir $"($tmpdir)/etc/tailscale"
          cp $ts_authkey_path $"($tmpdir)/etc/tailscale/authkey"
          $tmpdir
        } else {
          ""
        }

        print "Installing NixOS..."
        let flake_dir = $"($env.HOME)/.config"
        let extra_args = if $extra_files != "" { [--extra-files $extra_files] } else { [] }
        (^nix run github:nix-community/nixos-anywhere --
          --flake $"($flake_dir)#nixxxos"
          --ssh-option $"IdentityFile=($id)"
          --target-host $"root@($ip)"
          ...$extra_args)

        if $extra_files != "" { rm -rf $extra_files }

        if ($ts_authkey_path | is-not-empty) {
          print "Done! Auth key provisioned — box will auto-join the tailnet on boot."
          print $"Check tailnet IP with: ssh -i ($id) root@($ip) 'tailscale ip -4'"
        } else {
          print $"Done! ssh -i ($id) root@($ip)"
          print "No TS_AUTHKEY configured. Run 'sudo tailscale up' on the box to join a tailnet,"
          print "or store an auth key with: cd ~/.config/infra && secretspec set TS_AUTHKEY"
        }
      }
    '';
  };
in
{
  tfPlan = writeNushellApplication {
    name = "tf-plan";
    runtimeInputs = infraInputs;
    text = ''
      source ${libFile}

      def --wrapped main [--identity (-i): string, ...rest: string] {
        let id = (parse-identity -i $identity)
        with-infra $id ${keysFile} ${infraDir} {
          ^terraform plan -var-file=terraform.tfvars ...$rest
        }
      }
    '';
  };

  tfVars = writeNushellApplication {
    name = "tf-vars";
    runtimeInputs = infraInputs;
    text = ''
      source ${libFile}

      def main [--identity (-i): string] {
        cd ${infraDir}
        let id = (parse-identity -i $identity)

        decrypt-vars $id

        let editor = ($env.EDITOR? | default "nvim")
        ^$editor terraform.tfvars

        encrypt-vars ${keysFile}
        cleanup-vars
      }
    '';
  };

  provision = pkgs.writeShellScriptBin "provision" ''
    set -euo pipefail
    cd "$HOME/.config/infra"
    exec ${pkgs.secretspec}/bin/secretspec run -- ${provisionInner}/bin/provision-inner "$@"
  '';
}
