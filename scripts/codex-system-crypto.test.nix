{
  lib,
  codex,
  aws-lc,
  openssl,
}:
assert lib.assertMsg (builtins.any (
  input: input.drvPath == aws-lc.drvPath
) codex.buildInputs) "Codex must provide AWS-LC for the system-only aws-lc-sys build";
assert lib.assertMsg (builtins.any (
  input: input.drvPath == openssl.drvPath
) codex.buildInputs) "Codex must retain its existing OpenSSL dependency alongside AWS-LC";
true
