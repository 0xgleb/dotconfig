{ pkgs, ... }:
{
  users.users.root.shell = pkgs.nushell;
}
