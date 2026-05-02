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
    def with-infra [identity: string, action: closure] {
      cd $"($env.HOME)/.config/infra"
      if not (".terraform" | path exists) { ^terraform init }

      let fresh = not ("terraform.tfvars.age" | path exists)
      if $fresh {
        cp example.terraform.tfvars terraform.tfvars
        let editor = ($env.EDITOR? | default "nvim")
        ^$editor terraform.tfvars
      } else {
        ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age
      }

      let keys_file = $"($env.HOME)/.config/keys.nix"
      let recipients = (^nix eval --raw --file $keys_file roles.infra --apply 'builtins.concatStringsSep "\n"')
      let failed = (try { do $action; false } catch { true })
      $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars
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
      def --wrapped main [--identity (-i): string, ...rest: string] {
        let id = ($identity | default $"($env.HOME)/.ssh/id_ed25519")
        with-infra $id { ^terraform plan -var-file=terraform.tfvars ...$rest }
      }
    '';
  };

  tfVars = writeNushellApplication {
    name = "tf-vars";
    runtimeInputs = infraInputs;
    text = ''
      def main [--identity (-i): string] {
        cd $"($env.HOME)/.config/infra"
        let identity = ($identity | default $"($env.HOME)/.ssh/id_ed25519")
        let keys_file = $"($env.HOME)/.config/keys.nix"

        if not ("terraform.tfvars.age" | path exists) {
          cp example.terraform.tfvars terraform.tfvars
        } else {
          ^rage -d -i $identity -o terraform.tfvars terraform.tfvars.age
        }

        let editor = ($env.EDITOR? | default "nvim")
        ^$editor terraform.tfvars

        let recipients = (^nix eval --raw --file $keys_file roles.infra --apply 'builtins.concatStringsSep "\n"')
        $recipients | ^rage -e -R /dev/stdin -o terraform.tfvars.age terraform.tfvars
        rm -f terraform.tfvars
      }
    '';
  };

  provision = writeNushellApplication {
    name = "provision";
    runtimeInputs = infraInputs ++ [ pkgs.openssh ];
    text = ''
      ${infraPreamble}
      def main [--identity (-i): string, droplet_size: string = "s-2vcpu-4gb"] {
        let id = ($identity | default $"($env.HOME)/.ssh/id_ed25519")
        with-infra $id {
          ^terraform apply -var-file=terraform.tfvars -var $"droplet_size=($droplet_size)" -auto-approve
        }

        cd $"($env.HOME)/.config/infra"
        let ssh_key = $id
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

}
