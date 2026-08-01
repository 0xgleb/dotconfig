import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./piece-of-pi.ts", import.meta.url),
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
  assert.match(source, /"setMessageReaction"/);
  assert.match(source, /"👀"/);
  assert.match(source, /"sendChatAction"/);
  assert.match(source, /BRIDGE_TYPING_REFRESH_MS/);
  assert.match(source, /TELEGRAM_BURST_WINDOW_MS/);
  assert.match(source, /coalesceTelegramUpdates/);
  assert.match(source, /"setMyCommands"/);
  assert.match(source, /command: "kanban"/);
  assert.match(source, /downloadTelegramPhoto/);
});

test("unauthorized messages are rate-limited before bridge access", () => {
  assert.match(source, /consumeRejectionReplyAllowance/);
  assert.match(
    source,
    /authorization\.kind === "rejected"[\s\S]*?consumeRejectionReplyAllowance[\s\S]*?return Effect\.void/,
  );
  assert.match(source, /runtime\.bridge[\s\S]*?enqueue/);
});
