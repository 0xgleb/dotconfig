import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
const daemon = readFileSync(
  new URL("../pi/extensions/remote-control/piece-of-pi.ts", import.meta.url),
  "utf8",
)
const threatModel = readFileSync(
  new URL("../pi/extensions/remote-control/TELEGRAM.md", import.meta.url),
  "utf8",
)

/**
 * The token path is the literal system ragenix mount rather than
 * `config.age.secrets.<name>.path`: the secret is declared by the nix-darwin
 * ragenix module, whose option tree Home Manager does not evaluate. Reaching
 * for the darwin attrset here is what `piece-of-pi-secret-wiring.test.ts`
 * forbids, so both invariants pin the same mount point.
 */
test("Home Manager runs the owner-only Telegram bridge from the ragenix token path", () => {
  assert.match(home, /launchd\.agents\.pieceOfPiTelegram/)
  assert.match(home, /PIECE_OF_PI_TELEGRAM_OWNER_USERNAME = "dianov"/)
  assert.match(
    home,
    /PIECE_OF_PI_TELEGRAM_TOKEN_FILE = "\/run\/agenix\/metagenda-telegram-token"/,
  )
  assert.match(home, /KeepAlive = true/)
  assert.match(home, /RunAtLoad = true/)
})

test("Telegram polling remains private-message-only and capability-free", () => {
  assert.match(
    daemon,
    /allowed_updates: \["message", "edited_message", "message_reaction"\]/,
  )
  assert.match(daemon, /authorizeTelegramMessage/)
  assert.match(daemon, /makeRemoteBridgeStore/)
  assert.doesNotMatch(daemon, /enterRemoteToolGuard|setActiveTools|child_process|execFile|spawn\(/)
})

test("Telegram telemetry is structured and excludes protected values", () => {
  assert.doesNotMatch(daemon, /console\.(?:log|error|warn)/)
  assert.doesNotMatch(daemon, /emit\([^\n]*(?:token|username|userId|chatId|text)/i)
  assert.match(threatModel, /Operator questions and signals/)
  assert.match(threatModel, /token, message text, voice audio\/transcript, username, numeric user ID, session ID, and response text are absent from telemetry/)
})
