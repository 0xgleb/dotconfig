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

  infraPreamble = ''
    def with-infra [action: closure] {
      cd $"($env.HOME)/.config/infra"
      if not (".terraform" | path exists) { ^terraform init }

      let identity = $"($env.HOME)/.ssh/nixxxos_ed25519"
      ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age

      let failed = (try { do $action; false } catch { true })
      rm -f terraform.tfvars
      if $failed { exit 1 }
    }
  '';
in
{
  tfPlan = writeNushellApplication {
    name = "tf-plan";
    runtimeInputs = infraInputs;
    text = ''
      ${infraPreamble}
      def --wrapped main [...rest: string] {
        with-infra { ^terraform plan -var-file=terraform.tfvars ...$rest }
      }
    '';
  };

  tfEditVars = writeNushellApplication {
    name = "tf-edit-vars";
    runtimeInputs = infraInputs;
    text = ''
      def main [] {
        cd $"($env.HOME)/.config/infra"
        let identity = $"($env.HOME)/.ssh/nixxxos_ed25519"
        let keys_file = $"($env.HOME)/.config/keys.nix"

        ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age

        let editor = ($env.EDITOR? | default "nvim")
        ^$editor terraform.tfvars

        let recipients = (^nix eval --raw --file $keys_file roles.infra --apply 'builtins.concatStringsSep "\n"')
        $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars
        rm -f terraform.tfvars
      }
    '';
  };

  nixxxosUp = writeNushellApplication {
    name = "nixxxos-up";
    runtimeInputs = infraInputs ++ [ pkgs.openssh ];
    text = ''
      ${infraPreamble}
      def main [droplet_size: string = "s-2vcpu-4gb"] {
        with-infra {
          ^terraform apply -var-file=terraform.tfvars -var $"droplet_size=($droplet_size)" -auto-approve
        }

        cd $"($env.HOME)/.config/infra"
        let ssh_key = $"($env.HOME)/.ssh/nixxxos_ed25519"
        let flake_dir = $"($env.HOME)/.config"
        let ip = (^terraform output -raw ip | str trim)
        print "Waiting for SSH..."

        loop {
          let result = (do { ^ssh -i $ssh_key -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new $"root@($ip)" true } | complete)
          if $result.exit_code == 0 { break }
          sleep 2sec
        }

        print "Installing NixOS..."
        (^nix run github:nix-community/nixos-anywhere --
          --flake $"($flake_dir)#nixxxos"
          --ssh-option $"IdentityFile=($ssh_key)"
          --target-host $"root@($ip)")

        let ts_authkey = ($env.TS_AUTHKEY? | default "")
        if $ts_authkey != "" {
          print "Joining tailnet..."
          ^ssh -i $ssh_key -o StrictHostKeyChecking=accept-new $"root@($ip)" $"tailscale up --auth-key=($ts_authkey) --hostname=nixxxos"
          let tailnet_ip = (^ssh -i $ssh_key $"root@($ip)" "tailscale ip -4" | str trim)
          print $"Done! Tailnet IP: ($tailnet_ip)"
          print $"ssh -i ($ssh_key) 0xgleb@($tailnet_ip)"
        } else {
          print $"Done! ssh -i ($ssh_key) 0xgleb@($ip)"
          print "Run 'sudo tailscale up' on the box to join a tailnet."
        }
      }
    '';
  };

  nixxxosDown = writeNushellApplication {
    name = "nixxxos-down";
    runtimeInputs = infraInputs;
    text = ''
      ${infraPreamble}
      def main [] {
        with-infra { ^terraform destroy -var-file=terraform.tfvars -auto-approve }
      }
    '';
  };
}
