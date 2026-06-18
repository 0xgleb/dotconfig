let
  keys = {
    server = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8m2M/93ymq8JIG/cDvNhXnHDrI7mzSjKhZBLTgdKXe";

    # doop is the digital ocean op SSH key referenced in terraform as "doop".
    # it's the initial key digital ocean gives access to
    doop = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN/KMPlaN/tD5ia465z6rrkbrJnmtUyi+MNlky4DYRWg";

    # ci is the public half of the keypair GitHub Actions uses to deploy to
    # nixxxos (private half stored as the DEPLOY_SSH_KEY repository secret).
    # Leave empty to disable CI deploys; empty keys are filtered out where the
    # authorized_keys list is built, so the config stays valid until set.
    ci = "";
  };

  nonEmpty = builtins.filter (key: key != "");
in
{
  inherit keys;

  # Keys authorized to log into the nixxxos hosts (root + 0xgleb).
  authorized = nonEmpty (builtins.attrValues keys);

  roles.infra = with keys; [
    server
    doop
  ];
}
