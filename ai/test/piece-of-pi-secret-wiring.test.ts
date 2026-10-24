import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

test("Piece of Pi uses system ragenix before its user launch agent starts", () => {
  const flake = read("../../flake.nix")
  const darwin = read("../../darwin.nix")
  const home = read("../../home.nix")

  assert.match(flake, /inputs\.ragenix\.darwinModules\.default/)
  assert.match(darwin, /age\.identityPaths/)
  assert.match(darwin, /piece-of-pi\.txt/)
  assert.match(darwin, /metagenda-telegram-token\.file/)
  assert.match(darwin, /metagenda-telegram-token\.owner = userConfig\.name/)
  assert.match(
    home,
    /PIECE_OF_PI_TELEGRAM_TOKEN_FILE = "\/run\/agenix\/metagenda-telegram-token"/,
  )
  assert.doesNotMatch(home, /config\.age\.secrets/)
  assert.doesNotMatch(home, /TELEGRAM_TOKEN\s*=/)
})
