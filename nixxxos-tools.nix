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

  defaultIdentity = "$\"($env.HOME)/.ssh/nixxxos_ed25519\"";

  infraPreamble = ''
    def with-infra [identity: path, action: closure] {
      cd $"($env.HOME)/.config/infra"
      if not (".terraform" | path exists) { ^terraform init }

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
      def --wrapped main [--identity (-i): path = ${defaultIdentity}, ...rest: string] {
        with-infra $identity { ^terraform plan -var-file=terraform.tfvars ...$rest }
      }
    '';
  };

  tfApply = writeNushellApplication {
    name = "tf-apply";
    runtimeInputs = infraInputs;
    text = ''
      ${infraPreamble}
      def --wrapped main [--identity (-i): path = ${defaultIdentity}, ...rest: string] {
        with-infra $identity { ^terraform apply -var-file=terraform.tfvars ...$rest }
      }
    '';
  };

  tfDestroy = writeNushellApplication {
    name = "tf-destroy";
    runtimeInputs = infraInputs;
    text = ''
      ${infraPreamble}
      def main [--identity (-i): path = ${defaultIdentity}] {
        with-infra $identity { ^terraform destroy -var-file=terraform.tfvars -auto-approve }
      }
    '';
  };

  tfEditVars = writeNushellApplication {
    name = "tf-edit-vars";
    runtimeInputs = infraInputs;
    text = ''
      def main [--identity (-i): path = ${defaultIdentity}] {
        cd $"($env.HOME)/.config/infra"
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

  bootstrap = writeNushellApplication {
    name = "nixxxos-bootstrap";
    runtimeInputs = infraInputs ++ [ pkgs.openssh ];
    text = ''
      def main [--identity (-i): path = ${defaultIdentity}] {
        cd $"($env.HOME)/.config/infra"
        let ip = (^terraform output -raw ip | str trim)
        let flake_dir = $"($env.HOME)/.config"

        print $"Waiting for SSH on ($ip)..."
        loop {
          let result = (do { ^ssh -i $identity -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new $"root@($ip)" true } | complete)
          if $result.exit_code == 0 { break }
          sleep 2sec
        }

        print "Installing NixOS..."
        (^nix run github:nix-community/nixos-anywhere --
          --flake $"($flake_dir)#nixxxos"
          --ssh-option $"IdentityFile=($identity)"
          --target-host $"root@($ip)")

        print "Waiting for host to come back..."
        loop {
          let result = (do { ^ssh -i $identity -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new $"root@($ip)" true } | complete)
          if $result.exit_code == 0 { break }
          sleep 5sec
        }

        let ts_authkey = ($env.TS_AUTHKEY? | default "")
        if $ts_authkey != "" {
          print "Joining tailnet..."
          ^ssh -i $identity $"root@($ip)" $"tailscale up --auth-key=($ts_authkey) --hostname=nixxxos"
          let tailnet_ip = (^ssh -i $identity $"root@($ip)" "tailscale ip -4" | str trim)
          print $"Tailnet IP: ($tailnet_ip)"
          print ""
          print "Next: SSH in and authenticate Claude Code for remote control:"
          print $"  ssh -i <key> 0xgleb@($tailnet_ip)"
          print "  claude auth login"
          print "  sudo systemctl start claude-remote-control"
        } else {
          print "WARNING: No TS_AUTHKEY set. Port 22 is closed by default."
          print "Set TS_AUTHKEY env var to join a tailnet for SSH access."
        }
      }
    '';
  };
}
