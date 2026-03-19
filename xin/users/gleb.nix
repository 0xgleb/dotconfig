{ pkgs, lib, ... }:
let
  name = "0xgleb";
in
{
  _module.args.userConfig = { inherit name; };

  users.knownUsers = lib.mkIf pkgs.stdenv.isDarwin [ name ];

  users.users.${name} =
    {
      inherit name;
      shell = pkgs.nushell;
    }
    // lib.optionalAttrs pkgs.stdenv.isDarwin {
      home = "/Users/${name}";
      uid = 501;
    }
    // lib.optionalAttrs pkgs.stdenv.isLinux {
      isNormalUser = true;
      extraGroups = [ "wheel" ];
    };
}
