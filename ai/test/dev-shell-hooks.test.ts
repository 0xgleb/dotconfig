import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const readConfiguration = (path: string): string => {
  const file = new URL(path, import.meta.url)
  return existsSync(file) ? readFileSync(file, "utf8") : ""
}

test("static wiring: direnv selects the repository's pinned Nix shell", () => {
  const envrc = readConfiguration("../../.envrc")
  assert.match(envrc, /^use nix$/m)
  assert.match(envrc, /watch_file.*flake\.lock/)
  const shell = readConfiguration("../../shell.nix")
  assert.match(shell, /builtins\.getFlake/)
  assert.match(shell, /flake\.inputs\.nixpkgs/)
  assert.match(shell, /mkShellNoCC/)
})

test("static wiring: the shell declares formatter tools and normal hook installation", () => {
  const shell = readConfiguration("../../shell.nix")
  assert.match(shell, /pkgs\.prek/)
  assert.match(shell, /pkgs\.prettier/)
  assert.match(shell, /pkgs\.nodejs/)
  assert.match(shell, /shellHook[\s\S]*prek install/)
  assert.doesNotMatch(shell, /--no-verify|--force|SKIP=/)
})
