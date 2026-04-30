let
  keys = {
    nixxxos = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8m2M/93ymq8JIG/cDvNhXnHDrI7mzSjKhZBLTgdKXe nixxxos";
  };
in
{
  inherit keys;
  roles.infra = with keys; [ nixxxos ];
}
