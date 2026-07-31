let
  mateiS22Ultra = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHepyxN9hvXzbCY/z0amzldy7DXjNdyetnVaQexRgDEX";
in
{
  "secrets/metagenda-telegram-token.age".publicKeys = [ mateiS22Ultra ];
}
