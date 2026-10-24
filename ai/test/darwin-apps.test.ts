import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const darwin = readFileSync(
  new URL("../../darwin.nix", import.meta.url),
  "utf8",
)

test("Brave has one application-bundle source instead of a duplicate Nix Apps bundle", () => {
  const systemPackages =
    darwin.match(
      /environment\.systemPackages\s*=\s*with pkgs;\s*\[([\s\S]*?)\];/,
    )?.[1] ?? ""
  assert.doesNotMatch(systemPackages, /^\s*brave\s*$/m)
})
