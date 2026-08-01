import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
  "utf8",
);
const voiceProcessSource = readFileSync(
  new URL("./voice-process.ts", import.meta.url),
  "utf8",
);
const homeNix = readFileSync(
  new URL("../../../../home.nix", import.meta.url),
  "utf8",
);

test("one invalid Telegram message reports failure and cannot wedge later updates", () => {
  assert.match(source, /const handleUpdateFailure/);
  assert.match(source, /could not handle that message/i);
  assert.match(
    source,
    /Effect\.catchAll\(\(error\) =>[\s\S]*?handleUpdateFailure/,
  );
  assert.match(source, /nextUpdateId: update\.updateId \+ 1/);
  assert.match(source, /event: "update_failed"|emit\("update_failed"/);
});

test("replies to ordinary bot messages continue as agent conversation", () => {
  assert.doesNotMatch(
    source,
    /That reply is not attached to a pending Pi question/,
  );
  assert.match(
    source,
    /error\.code !== "not_found"[\s\S]*?return Effect\.succeed\(false\)/,
  );
});

test("Telegram UX uses reactions, recurring activity, commands, batching, and images", () => {
  assert.doesNotMatch(source, /Queued for|Working on it|Reading the image/);
  assert.doesNotMatch(source, /PROGRESS_MESSAGE_DELAY_MS|editMessageText/);
  assert.doesNotMatch(source, /Please retry or use \/agents to select another agent/);
  assert.match(source, /"setMessageReaction"/);
  assert.match(source, /telegramAcknowledgementReaction/);
  assert.match(source, /lastAcknowledgementReaction/);
  assert.match(source, /state\.lastAcknowledgementReaction/);
  assert.doesNotMatch(source, /"👍"|"😢"/);
  assert.match(source, /"sendChatAction"/);
  assert.match(source, /BRIDGE_TYPING_REFRESH_MS/);
  assert.match(source, /TELEGRAM_BURST_WINDOW_MS/);
  assert.match(source, /TELEGRAM_MAX_BURST_WAIT_MS/);
  assert.match(source, /TELEGRAM_MAX_BURST_UPDATES/);
  assert.match(
    source,
    /collectTelegramUpdateBurstTail[\s\S]*?additionalUpdates\.length === 0[\s\S]*?collectTelegramUpdateBurstTail\(/,
  );
  assert.match(source, /coalesceTelegramUpdates/);
  assert.match(source, /"setMyCommands"/);
  assert.match(source, /command: "kanban"/);
  assert.match(source, /downloadTelegramPhoto/);
});

test("voice notes authenticate before bounded local transcription", () => {
  const updateBody = source.slice(source.indexOf("const handleUpdateBody"));
  const authorization = updateBody.indexOf("authorization.kind === \"rejected\"");
  const transcription = updateBody.indexOf("transcribeOwnerVoice(runtime, update)");
  assert.ok(authorization >= 0);
  assert.ok(transcription > authorization);
  assert.match(source, /downloadTelegramVoice/);
  assert.match(source, /telegramVoiceFromBytes/);
  assert.match(voiceProcessSource, /spawn\("whisper-cli"/);
  assert.match(source, /mkdtemp[\s\S]*?piece-of-pi-voice-/);
  assert.match(
    voiceProcessSource,
    /rm\(directory, \{ recursive: true, force: true \}\)/,
  );
  assert.match(
    voiceProcessSource,
    /WHISPER_TIMEOUT_MS[\s\S]*?onClose[\s\S]*?child\.kill\("SIGTERM"\)[\s\S]*?child\.kill\("SIGKILL"\)/,
  );
  assert.match(voiceProcessSource, /VOICE_CLEANUP_ATTEMPTS = 3/);
  assert.match(source, /replaceVoiceMarker[\s\S]*?voice\.messageId/);
  assert.doesNotMatch(
    `${source}\n${voiceProcessSource}`,
    /exec\([^\n]*whisper|shell:\s*true/,
  );
  assert.match(
    homeNix,
    /pieceOfPiWhisper = pkgs\.whisper-cpp\.override \{[\s\S]*?coreMLSupport = false;[\s\S]*?withSDL = false;/,
  );
  assert.match(homeNix, /runtimeInputs = \[[\s\S]*?pieceOfPiWhisper/);
  assert.match(homeNix, /PIECE_OF_PI_WHISPER_MODEL/);
})

test("owner reactions become bounded context without authorizing actions", () => {
  assert.match(source, /allowed_updates: \["message", "edited_message", "message_reaction"\]/);
  assert.match(source, /pendingReactionFeedback/);
  assert.match(source, /conversational feedback only, never action authorization/);
  assert.match(source, /handleReactionUpdate/);
});

test("unauthorized messages are rate-limited before bridge access", () => {
  assert.match(source, /consumeRejectionReplyAllowance/);
  assert.match(
    source,
    /authorization\.kind === "rejected"[\s\S]*?consumeRejectionReplyAllowance[\s\S]*?return Effect\.void/,
  );
  assert.match(source, /runtime\.bridge[\s\S]*?enqueue/);
});
