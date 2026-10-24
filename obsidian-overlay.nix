# The darwin obsidian packaging hardcodes sourceRoot = "Obsidian.app", but
# the DMG layout moved: 1.13.4 mounts as "Obsidian <version>-universal/" with
# the app bundle nested inside, so unpackPhase dies with "chmod: cannot
# access 'Obsidian.app'". Locate the bundle instead of hardcoding either
# layout so both the old (app at volume root) and new (nested) images build.
# Remove once upstream nixpkgs unpacks the current Obsidian DMG on darwin.
final: prev: {
  obsidian =
    if prev.stdenv.hostPlatform.isDarwin then
      prev.obsidian.overrideAttrs {
        version = "1.14.4";
        src = prev.fetchurl {
          url = "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.14.4/Obsidian-1.14.4.dmg";
          hash = "sha256-3PgY3SDuXZ3T54Lu4MDExHzCJTg7BRwvya99V3L1n3A=";
        };
        sourceRoot = null;
        setSourceRoot = ''
          sourceRoot=$(find . -maxdepth 2 -type d -name 'Obsidian.app' -print -quit)
          if [ -z "$sourceRoot" ]; then
            echo "Obsidian.app not found in the unpacked DMG" >&2
            exit 1
          fi
          sourceRoot=$(dirname "$sourceRoot")
        '';
      }
    else
      prev.obsidian;
}
