import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
  "utf8",
)
const voiceProcessSource = readFileSync(
  new URL("./voice-process.ts", import.meta.url),
  "utf8",
)
const homeNix = readFileSync(
  new URL("../../../../home.nix", import.meta.url),
  "utf8",
)

test("Telegram chat lists and routes only native Pi inbox agents", () => {
  assert.match(source, /const availableChatAgents =/)
  assert.match(
    source,
    /availableAgents\(runtime\)\.pipe\(Effect\.map\(telegramRoutableAgents\)\)/,
  )
  assert.match(
    source,
    /const chooseAgent[\s\S]*?availableChatAgents\(runtime\)/,
  )
  assert.match(
    source,
    /const selectAgent[\s\S]*?availableChatAgents\(runtime\)/,
  )
  assert.match(
    source,
    /command === "\/agents"[\s\S]*?availableChatAgents\(runtime\)/,
  )
})

test("a hung Telegram request times out without exposing the bot token", () => {
  const boundary = source.slice(
    source.indexOf("const telegramCall ="),
    source.indexOf("const downloadTelegramPhoto ="),
  )
  assert.match(source, /const telegramCallTimeoutMilliseconds =/)
  assert.match(source, /Math\.max\(TELEGRAM_CALL_TIMEOUT_MS/)
  assert.match(boundary, /try: (?:async )?signal =>/)
  assert.match(boundary, /body: JSON\.stringify\(body\),[\s\S]*?signal,/)
  assert.match(
    boundary,
    /Effect\.timeout\(telegramCallTimeoutMilliseconds\(method, body\)\)/,
  )
  assert.match(boundary, /message: `Telegram \$\{method\} request failed`/)
  assert.doesNotMatch(boundary, /configuration\.token[^\n]*message/)
})

test("one invalid Telegram message reports failure and cannot wedge later updates", () => {
  assert.match(source, /const handleUpdateFailure/)
  assert.match(source, /could not handle that message/i)
  assert.match(source, /Effect\.catchAll\(error =>[\s\S]*?handleUpdateFailure/)
  assert.match(source, /nextUpdateId: update\.updateId \+ 1/)
  assert.match(source, /event: "update_failed"|emit\("update_failed"/)
})

test("Telegram replies to terminal Pi questions never fall into expiring agent dispatch", () => {
  assert.match(
    source,
    /error\.code === "invalid_transition"[\s\S]*?already resolved[\s\S]*?not queued[\s\S]*?Effect\.as\(true\)/i,
  )
  assert.match(
    source,
    /if \(error\.code !== "not_found"\)[\s\S]*?return Effect\.fail\(error\)[\s\S]*?return Effect\.succeed\(false\)/,
  )
})

test("Telegram UX uses reactions, recurring activity, commands, batching, and images", () => {
  assert.doesNotMatch(source, /Queued for|Working on it|Reading the image/)
  assert.doesNotMatch(source, /PROGRESS_MESSAGE_DELAY_MS/)
  assert.match(source, /editMessageText/)
  assert.match(source, /answerCallbackQuery/)
  assert.match(source, /command: "caba"/)
  assert.match(source, /ensureCabaSession[\s\S]*?sendTelegramMessage/)
  assert.doesNotMatch(
    source,
    /Please retry or use \/agents to select another agent/,
  )
  assert.match(source, /"setMessageReaction"/)
  assert.match(source, /telegramAcknowledgementReaction/)
  assert.match(source, /lastAcknowledgementReaction/)
  assert.match(source, /state\.lastAcknowledgementReaction/)
  assert.doesNotMatch(source, /"👍"|"😢"/)
  assert.match(source, /"sendChatAction"/)
  assert.match(source, /BRIDGE_TYPING_REFRESH_MS/)
  assert.match(source, /TELEGRAM_BURST_WINDOW_MS/)
  assert.match(source, /TELEGRAM_MAX_BURST_WAIT_MS/)
  assert.match(source, /TELEGRAM_MAX_BURST_UPDATES/)
  assert.match(
    source,
    /collectTelegramUpdateBurstTail[\s\S]*?additionalUpdates\.length === 0[\s\S]*?collectTelegramUpdateBurstTail\(/,
  )
  assert.match(source, /coalesceTelegramUpdates/)
  assert.match(source, /"setMyCommands"/)
  assert.match(source, /command: "kanban"/)
  assert.match(source, /downloadTelegramPhoto/)
})

test("voice notes authenticate before bounded local transcription", () => {
  const updateBody = source.slice(source.indexOf("const handleUpdateBody"))
  const authorization = updateBody.indexOf('authorization.kind === "rejected"')
  const transcription = updateBody.indexOf(
    "transcribeOwnerVoice(runtime, update)",
  )
  assert.ok(authorization >= 0)
  assert.ok(transcription > authorization)
  assert.match(source, /downloadTelegramVoice/)
  assert.match(source, /telegramVoiceFromBytes/)
  assert.match(voiceProcessSource, /spawn\("whisper-cli"/)
  assert.match(source, /mkdtemp[\s\S]*?piece-of-pi-voice-/)
  assert.match(
    voiceProcessSource,
    /rm\(directory, \{ recursive: true, force: true \}\)/,
  )
  assert.match(
    voiceProcessSource,
    /WHISPER_TIMEOUT_MS[\s\S]*?onClose[\s\S]*?child\.kill\("SIGTERM"\)[\s\S]*?child\.kill\("SIGKILL"\)/,
  )
  assert.match(voiceProcessSource, /VOICE_CLEANUP_ATTEMPTS = 3/)
  assert.match(source, /replaceVoiceMarker[\s\S]*?voice\.messageId/)
  assert.doesNotMatch(
    `${source}\n${voiceProcessSource}`,
    /exec\([^\n]*whisper|shell:\s*true/,
  )
  assert.match(
    homeNix,
    /pieceOfPiWhisper =[\s\S]*?pkgs\.whisper-cpp\.override \{[\s\S]*?coreMLSupport = false;[\s\S]*?withSDL = false;/,
  )
  assert.match(
    homeNix,
    /pieceOfPiWhisper[\s\S]*?overrideAttrs[\s\S]*?grep -q -F 'install\(' "\$target"/,
  )
  assert.doesNotMatch(homeNix, /install\(TARGETS whisper\.coreml LIBRARY\)/)
  assert.match(homeNix, /runtimeInputs = \[[\s\S]*?pieceOfPiWhisper/)
  assert.match(homeNix, /PIECE_OF_PI_WHISPER_MODEL/)
})

test("forwarded Telegram conversations keep typed attribution through bridge enqueue", () => {
  assert.match(
    source,
    /text: `\$\{reactionContext\}\$\{telegramOwnerConversationText\(update\.message, update\.message\.userId\)\}`/,
  )
  assert.match(
    source,
    /conversationParts = update\.message\.conversationParts\?\.map/,
  )
})

test("owner reactions become bounded context without authorizing actions", () => {
  assert.match(
    source,
    /allowed_updates:[\s\S]*?"message_reaction"[\s\S]*?"callback_query"/,
  )
  assert.match(source, /pendingReactionFeedback/)
  assert.match(
    source,
    /conversational feedback only, never action authorization/,
  )
  assert.match(source, /handleReactionUpdate/)
})

test("a chat registry never fails the state load and never records itself", () => {
  assert.match(source, /const chats = decodeChatRegistry\(candidate\.chats\)/)
  assert.doesNotMatch(source, /Piece of Pi chats? [\s\S]{0,24}is invalid/)
  assert.match(
    source,
    /handleGroupChatUpdate[\s\S]*?groupChatRegistration\([\s\S]*?runtime\.configuration\.ownerUsername/,
  )
  assert.match(
    source,
    /registration\.outcome === "unchanged"\) return Effect\.void/,
  )
  assert.match(source, /if \(update\.groupChat\)[\s\S]*?handleGroupChatUpdate/)
})

test("unauthorized messages are rate-limited before bridge access", () => {
  assert.match(source, /consumeRejectionReplyAllowance/)
  assert.match(
    source,
    /authorization\.kind === "rejected"[\s\S]*?consumeRejectionReplyAllowance[\s\S]*?return Effect\.void/,
  )
  assert.match(source, /runtime\.bridge[\s\S]*?enqueue/)
})
