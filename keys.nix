let
  keys = {
    server = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8m2M/93ymq8JIG/cDvNhXnHDrI7mzSjKhZBLTgdKXe";
  };

  nonEmpty = builtins.filter (key: key != "");
in
{
  inherit keys;

  # Keys authorized to log into the nixxxos hosts (root + 0xgleb).
  authorized = nonEmpty (builtins.attrValues keys);

  roles.infra = with keys; [
    server
  ];
}
