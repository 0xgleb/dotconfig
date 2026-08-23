import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

test("manual Nushell SSH sessions use a portable remote terminal type", () => {
  const config = read("../../nushell/config.src.nu")
  assert.match(config, /def --wrapped ssh \[\.\.\.args: string\]/)
  assert.match(
    config,
    /with-env \{ TERM: "xterm-256color" \} \{ \^ssh \.\.\.\$args \}/,
  )
})

test("provisioned remote attaches work before the remote generation is updated", () => {
  const provision = read("../../infra/provision.nu")
  assert.match(provision, /with-env \{ TERM: "xterm-256color" \} \{\s*\(\^ssh/s)
  assert.match(provision, /"zellij" "attach" "-c" "nixxxos"/)
})

test("NixOS installs Ghostty terminfo for native-capability SSH clients", () => {
  const nixos = read("../../nixos.nix")
  assert.match(
    nixos,
    /environment\.systemPackages = \[ pkgs\.ghostty\.terminfo \];/,
  )
})
