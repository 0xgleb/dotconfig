# gt >= 1.8.6 ships as a prebuilt vercel/pkg binary, and the nixpkgs
# packaging of it (PR #527044, only tested on x86_64-linux) is broken on
# darwin in two ways:
#
# - The darwin postInstall generates shell completions by running the
#   freshly installed binary, but gt >= 1.8.6 exits silently from
#   `gt completion` when HOME is not writable, and nix builds run with
#   HOME=/homeless-shelter, so installShellCompletion fails the build on
#   zero-size completion files. Process substitution swallows gt's exit
#   status, so the build log never shows the real error.
#
# - Upstream sets dontFixup only on Linux, so on darwin fixup strips and
#   re-signs the binary, corrupting the vercel/pkg virtual filesystem
#   appended to it ("Pkg: Error reading from file." on any invocation) —
#   despite the derivation's own comment that the binary must remain
#   completely unmodified.
#
# On Linux the packaging generates completions by RUNNING the freshly
# built FHS wrapper (`$out/bin/gt completion`), which shells through
# bubblewrap. That requires creating a user namespace inside the nix
# build sandbox; GitHub Actions runners (Ubuntu 24.04 AppArmor userns
# restrictions) deny it, bwrap fails with "setting up uid map: Permission
# denied", and installShellCompletion fails the whole system build on the
# resulting zero-size completion file. graphite-cli is unfree, so Hydra
# never exercises this path — it only works on machines where nested
# user namespaces happen to be permitted. The Linux branch below keeps
# upstream's completions when the wrapper can run and skips them when the
# sandbox says no, instead of failing the build over tab completion.
#
# Remove this overlay once upstream nixpkgs builds a working graphite-cli
# on both platforms again.
final: prev: {
  graphite-cli =
    if prev.stdenv.hostPlatform.isDarwin then
      prev.graphite-cli.overrideAttrs (old: {
        postInstall = "export HOME=$TMPDIR\n" + (old.postInstall or "");
        dontFixup = true;
      })
    else
      prev.callPackage (prev.path + "/pkgs/by-name/gr/graphite-cli/package.nix") {
        buildFHSEnv =
          args:
          prev.buildFHSEnv (
            args
            // {
              extraInstallCommands = ''
                ln -s $out/bin/graphite-cli $out/bin/gt
                if $out/bin/gt completion > /dev/null 2>&1; then
                  source ${prev.installShellFiles}/nix-support/setup-hook
                  installShellCompletion --cmd gt \
                    --bash <($out/bin/gt completion) \
                    --zsh <(ZSH_NAME=zsh $out/bin/gt completion) \
                    --fish <($out/bin/gt fish)
                else
                  echo "gt cannot run in this build sandbox (bwrap user namespace denied); skipping shell completions"
                fi
              '';
            }
          );
      };
}
