{ pkgs, upstreamAtuin }:
let
  package = pkgs.atuin;
  excludedTest = "--skip=filtered_commands_leave_no_captured_output";
in
assert pkgs.stdenv.hostPlatform.isDarwin;
assert package.doCheck;
assert builtins.elem excludedTest package.checkFlags;
# Preserve all upstream exclusions; add only the one owner-approved Darwin workaround.
assert builtins.filter (flag: flag != excludedTest) package.checkFlags == upstreamAtuin.checkFlags;
assert package.src.outPath == upstreamAtuin.src.outPath;
true
