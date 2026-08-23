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
# Linux is left exactly as upstream: completions are generated inside the
# buildFHSEnv wrapper there and the failure mode does not apply. Remove
# this overlay once upstream nixpkgs builds a working graphite-cli on
# darwin again.
final: prev: {
  graphite-cli =
    if prev.stdenv.hostPlatform.isDarwin then
      prev.graphite-cli.overrideAttrs (old: {
        postInstall = "export HOME=$TMPDIR\n" + (old.postInstall or "");
        dontFixup = true;
      })
    else
      prev.graphite-cli;
}
