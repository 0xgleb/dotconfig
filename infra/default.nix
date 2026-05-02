{ pkgs, system, deploy-rs }:
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

  deployInputs = [
    deploy-rs.packages.${system}.default
    pkgs.openssh
  ];

  keysFile = ../keys.nix;
  libFile = ../nushell/scripts/fj/infra/lib.nu;

  resolveDirs = ''
    let infra_dir = ($env.INFRA_DIR? | default $"($env.HOME)/.config/infra")
    let flake_dir = ($env.FLAKE_DIR? | default $"($env.HOME)/.config")
  '';

  provisionInner = writeNushellApplication {
    name = "provision-inner";
    runtimeInputs = infraInputs ++ deployInputs;
    text = ''
      source ${libFile}

      def main [--identity (-i): string, droplet_size: string = "s-2vcpu-4gb"] {
        ${resolveDirs}
        let id = (parse-identity -i $identity)
        let auth_keys = (authorized-keys ${keysFile})

        with-infra $id ${keysFile} $infra_dir {
          (^terraform apply -var-file=terraform.tfvars
            -var $"droplet_size=($droplet_size)"
            -var $"authorized_keys=($auth_keys)"
            -auto-approve)
        }

        cd $infra_dir
        let ip_result = (^terraform output -raw ip | complete)
        if $ip_result.exit_code != 0 {
          print $"terraform output failed \(exit ($ip_result.exit_code)\):"
          print $ip_result.stdout
          print $ip_result.stderr
          exit 1
        }
        if ($ip_result.stdout | str trim | is-empty) {
          print "terraform output -raw ip returned empty — no droplet to provision."
          exit 1
        }
        let ip = ($ip_result.stdout | str trim)

        let ssh_opts = [-i $id -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=yes]

        print $"Waiting for SSH on ($ip)..."
        let ssh_max_attempts = 60
        mut attempt = 0
        mut last_r = { exit_code: -1, stdout: "", stderr: "" }
        loop {
          $attempt = $attempt + 1
          let r = (^ssh ...$ssh_opts $"root@($ip)" true | complete)
          $last_r = $r
          if $r.exit_code == 0 { break }
          if $attempt >= $ssh_max_attempts {
            print $"SSH did not come up after ($ssh_max_attempts) attempts."
            print $"  last exit: ($r.exit_code)"
            print $"  stdout: ($r.stdout)"
            print $"  stderr: ($r.stderr)"
            exit 1
          }
          print $"  attempt ($attempt) failed \(exit ($r.exit_code)\), retrying in 5s..."
          sleep 5sec
        }

        let cloud_init_max_attempts = 60
        mut ci_attempt = 0
        mut cloud_init = { exit_code: -1, stdout: "", stderr: "" }
        loop {
          $ci_attempt = $ci_attempt + 1
          let r = (^ssh ...$ssh_opts $"root@($ip)" "cloud-init status" | complete)
          $cloud_init = $r
          let s = ($r.stdout | str trim)
          if ($s | str contains "status: done") or ($s | str contains "status: error") {
            break
          }
          if $ci_attempt >= $cloud_init_max_attempts {
            print $"cloud-init did not finish after ($cloud_init_max_attempts) checks."
            print $r.stdout
            print $r.stderr
            exit 1
          }
          sleep 5sec
        }
        if not ($cloud_init.stdout | str contains "status: done") {
          print $cloud_init.stdout
          print $cloud_init.stderr
          exit 1
        }

        let nix_check = (^ssh ...$ssh_opts $"root@($ip)" "test -x /usr/local/bin/nix-daemon" | complete)
        if $nix_check.exit_code != 0 {
          print "nix-daemon not found at /usr/local/bin/nix-daemon"
          exit 1
        }

        let ts_authkey_path = ($env.TS_AUTHKEY? | default "")
        let ts_authkey_valid = (
          ($ts_authkey_path | is-not-empty)
          and ($ts_authkey_path | path exists)
          and (((ls -l $ts_authkey_path | get 0.size) | into int) > 0)
        )
        if $ts_authkey_valid {
          ^ssh ...$ssh_opts $"root@($ip)" "mkdir -p /etc/tailscale && chmod 700 /etc/tailscale"
          ^scp ...$ssh_opts $ts_authkey_path $"root@($ip):/etc/tailscale/authkey"
          ^ssh ...$ssh_opts $"root@($ip)" "chmod 600 /etc/tailscale/authkey"
        } else {
          print "No TS_AUTHKEY configured — tailscale will install but not auto-join."
          print "Store an auth key with: cd ~/.config/infra && secretspec set TS_AUTHKEY"
        }

        let ssh_str = $"-i ($id) -o StrictHostKeyChecking=accept-new"
        with-env { DEPLOY_HOST: $ip, NIX_SSHOPTS: $ssh_str } {
          (^deploy --debug-logs --skip-checks
            --ssh-opts $ssh_str
            $"path:($flake_dir)#nixxxos"
            -- --impure --accept-flake-config)
        }

        print $"Done! ssh -i ($id) root@($ip)"
        if $ts_authkey_valid {
          print $"Tailnet IP: ssh -i ($id) root@($ip) 'tailscale ip -4'"
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
        ${resolveDirs}
        let id = (parse-identity -i $identity)
        let auth_keys = (authorized-keys ${keysFile})
        with-infra $id ${keysFile} $infra_dir {
          (^terraform plan -var-file=terraform.tfvars
            -var $"authorized_keys=($auth_keys)"
            ...$rest)
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
        ${resolveDirs}
        cd $infra_dir
        let id = (parse-identity -i $identity)

        decrypt-vars $id

        let editor = ($env.EDITOR? | default "nvim")
        ^$editor terraform.tfvars

        encrypt-vars ${keysFile}
        cleanup-vars
      }
    '';
  };

  tfDestroy = writeNushellApplication {
    name = "tf-destroy";
    runtimeInputs = infraInputs;
    text = ''
      source ${libFile}

      def --wrapped main [--identity (-i): string, ...rest: string] {
        ${resolveDirs}
        let id = (parse-identity -i $identity)
        let auth_keys = (authorized-keys ${keysFile})
        with-infra $id ${keysFile} $infra_dir {
          (^terraform destroy -var-file=terraform.tfvars
            -var $"authorized_keys=($auth_keys)"
            -auto-approve
            ...$rest)
        }
      }
    '';
  };

  tfOutput = writeNushellApplication {
    name = "tf-output";
    runtimeInputs = infraInputs;
    text = ''
      def --wrapped main [...rest: string] {
        ${resolveDirs}
        cd $infra_dir
        ^terraform output ...$rest
      }
    '';
  };

  provision = pkgs.writeShellScriptBin "provision" ''
    set -euo pipefail
    : "''${INFRA_DIR:=$HOME/.config/infra}"
    : "''${FLAKE_DIR:=$HOME/.config}"
    export INFRA_DIR FLAKE_DIR
    cd "$INFRA_DIR"
    provider="''${SECRETSPEC_PROVIDER:-keyring}"
    exec ${pkgs.secretspec}/bin/secretspec run --provider "$provider" -- ${provisionInner}/bin/provision-inner "$@"
  '';
}
