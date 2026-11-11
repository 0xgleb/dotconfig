{
  lib,
  codex,
  aws-lc,
  openssl,
  oniguruma,
  sqlite,
  zlib,
  zstd,
}:
assert lib.assertMsg (builtins.any (
  input: input.drvPath == aws-lc.drvPath
) codex.buildInputs) "Codex must provide AWS-LC for the system-only aws-lc-sys build";
assert lib.assertMsg (builtins.any (
  input: input.drvPath == openssl.drvPath
) codex.buildInputs) "Codex must retain its existing OpenSSL dependency alongside AWS-LC";
assert lib.all
  (
    dependency:
    lib.assertMsg (builtins.any (input: input.drvPath == dependency.drvPath)
      codex.buildInputs
    ) "Codex must provide the system ${dependency.pname} dependency required by Cargo"
  )
  [
    zstd
    sqlite
    oniguruma
    zlib
  ];
true
