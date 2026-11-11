{
  codex,
  aws-lc,
  oniguruma,
  sqlite,
  zlib,
  zstd,
}:
codex.overrideAttrs (previous: {
  buildInputs = previous.buildInputs ++ [
    aws-lc
    oniguruma
    sqlite
    zlib
    zstd
  ];
})
