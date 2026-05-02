let
  keys = {
    server = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8m2M/93ymq8JIG/cDvNhXnHDrI7mzSjKhZBLTgdKXe";

    # doop is the digital ocean op SSH key referenced in terraform as "doop".
    # it's the initial key digital ocean gives access to
    doop = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN/KMPlaN/tD5ia465z6rrkbrJnmtUyi+MNlky4DYRWg";
  };
in
{
  inherit keys;
  roles.infra = with keys; [ server doop ];
}
