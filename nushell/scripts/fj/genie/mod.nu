const default_identity = $"($nu.home-path)/.ssh/nixxxos_ed25519"
const infra_dir = $"($nu.home-path)/.config/infra"
const plan_file = "nixxxos.tfplan"

def with-infra [action: closure] {
  cd $infra_dir
  if not (".terraform" | path exists) {
    ^terraform init
  }

  ^rage -d -i $default_identity -o terraform.tfvars terraform.tfvars.age

  let failed = (try { do $action; false } catch { true })
  rm -f terraform.tfvars
  if $failed { exit 1 }
}

def tailnet-ip [] {
  cd $infra_dir
  let ip = (^terraform output -raw ip | str trim)
  let result = (do { ^ssh -i $default_identity -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new $"root@($ip)" "tailscale ip -4" } | complete)
  if $result.exit_code != 0 {
    error make --unspanned { msg: "could not get tailnet IP -- is the instance up and on tailscale?" }
  }
  $result.stdout | str trim
}

export def main [] {
  cd $infra_dir
  let ip_result = (do { ^terraform output -raw ip } | complete)
  if $ip_result.exit_code != 0 or ($ip_result.stdout | str trim) == "" {
    print "no instance provisioned"
    return
  }
  let ip = ($ip_result.stdout | str trim)
  print $"droplet: ($ip)"

  let ts_result = (do { ^ssh -i $default_identity -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new $"root@($ip)" "tailscale ip -4" } | complete)
  if $ts_result.exit_code == 0 {
    print $"tailnet: ($ts_result.stdout | str trim)"
  } else {
    print "tailnet: not connected"
  }

  let svc_result = (do { ^ssh -i $default_identity -o ConnectTimeout=3 $"root@($ip)" "systemctl is-active claude-remote-control" } | complete)
  print $"claude:  ($svc_result.stdout | str trim)"
}

export def bottle [] {
  with-infra {
    ^terraform plan -var-file=terraform.tfvars -out $plan_file
  }
  print $"\nplan saved. run (ansi green)fj genie bottle open(ansi reset) to apply."
}

export def "bottle open" [] {
  cd $infra_dir
  if not ($plan_file | path exists) {
    error make --unspanned { msg: $"no plan file found. run `fj genie bottle` first." }
  }

  ^terraform apply $plan_file
  rm -f $plan_file

  print $"\ndroplet provisioned. run (ansi green)fj genie bootstrap(ansi reset) to install NixOS."
}

export def bootstrap [] {
  cd $infra_dir
  let ip = (^terraform output -raw ip | str trim)
  let flake_dir = $"($nu.home-path)/.config"

  print $"waiting for SSH on ($ip)..."
  loop {
    let result = (do { ^ssh -i $default_identity -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new $"root@($ip)" true } | complete)
    if $result.exit_code == 0 { break }
    sleep 2sec
  }

  print "installing NixOS..."
  (^nix run github:nix-community/nixos-anywhere --
    --flake $"($flake_dir)#nixxxos"
    --ssh-option $"IdentityFile=($default_identity)"
    --target-host $"root@($ip)")

  print "waiting for host to come back..."
  loop {
    let result = (do { ^ssh -i $default_identity -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new $"root@($ip)" true } | complete)
    if $result.exit_code == 0 { break }
    sleep 5sec
  }

  let ts_authkey = ($env.TS_AUTHKEY? | default "")
  if $ts_authkey != "" {
    print "joining tailnet..."
    ^ssh -i $default_identity $"root@($ip)" $"tailscale up --auth-key=($ts_authkey) --hostname=nixxxos"
    let tailnet_ip = (^ssh -i $default_identity $"root@($ip)" "tailscale ip -4" | str trim)
    print $"tailnet IP: ($tailnet_ip)"
    print ""
    print "next steps:"
    print $"  ssh 0xgleb@($tailnet_ip)"
    print "  claude auth login"
    print "  sudo systemctl start claude-remote-control"
  } else {
    print "WARNING: no TS_AUTHKEY set. port 22 is closed by default."
    print "set TS_AUTHKEY env var to join a tailnet for SSH access."
  }
}

export def talk [] {
  let ip = (tailnet-ip)
  ^ssh -t $"0xgleb@($ip)" "zellij attach claude --create"
}

export def murder [] {
  with-infra {
    ^terraform destroy -var-file=terraform.tfvars
  }
}
