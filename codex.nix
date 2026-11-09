{ codex, aws-lc }:
codex.overrideAttrs (previous: {
  buildInputs = previous.buildInputs ++ [ aws-lc ];
})
