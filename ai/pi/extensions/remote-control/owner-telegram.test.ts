import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Effect, Either } from "effect";
import { pieceOfPiStatePath } from "./paths.ts";
import {
  deliverOwnerRelay,
  hasMultipleLinks,
  ownerRelayChunks,
  type OwnerRelayDeliveryCode,
} from "./owner-telegram.ts";

const VALID_TOKEN = "123456789:AAExample-Token_Value";

interface RelayFixture {
  readonly token?: string;
  readonly state?: string;
}

interface TelegramCall {
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The relay reads its token and the owner chat from two files named by the
 * environment, so a fixture root plus the two variables is the whole seam -
 * `fetch` is stubbed at the one place a real network call would happen.
 */
const relayAttempt = async (
  fixture: RelayFixture,
  reply: () => Response,
  text = "status",
): Promise<{
  readonly failure?: OwnerRelayDeliveryCode;
  readonly message: string;
  readonly calls: readonly TelegramCall[];
}> => {
  const root = mkdtempSync(join(tmpdir(), "owner-relay-"));
  const tokenFile = join(root, "telegram-token");
  if (fixture.token !== undefined) writeFileSync(tokenFile, fixture.token);
  if (fixture.state !== undefined) {
    const statePath = pieceOfPiStatePath(root, "/unused");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, fixture.state);
  }
  const previousTokenFile = process.env.PIECE_OF_PI_TELEGRAM_TOKEN_FILE;
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousFetch = globalThis.fetch;
  const calls: TelegramCall[] = [];
  process.env.PIECE_OF_PI_TELEGRAM_TOKEN_FILE = tokenFile;
  process.env.XDG_STATE_HOME = root;
  globalThis.fetch = ((
    input: unknown,
    init?: { readonly body?: unknown },
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Readonly<
        Record<string, unknown>
      >,
    });
    return Promise.resolve(reply());
  }) as typeof globalThis.fetch;
  try {
    const result = await Effect.runPromise(
      Effect.either(deliverOwnerRelay(text)),
    );
    return Either.isLeft(result)
      ? { failure: result.left.code, message: result.left.message, calls }
      : { message: "", calls };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTokenFile === undefined)
      delete process.env.PIECE_OF_PI_TELEGRAM_TOKEN_FILE;
    else process.env.PIECE_OF_PI_TELEGRAM_TOKEN_FILE = previousTokenFile;
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { recursive: true, force: true });
  }
};

const accepted = (): Response =>
  new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
    status: 200,
  });

const ownerState = JSON.stringify({ ownerChatId: 4_242 });

test("a relay with no readable token reports it instead of claiming delivery", async () => {
  const attempt = await relayAttempt({ state: ownerState }, accepted);
  assert.equal(attempt.failure, "token_unreadable");
  assert.equal(attempt.calls.length, 0, "an unsendable relay must not call Telegram");
});

test("a token that is not a bot token is refused before it is used", async () => {
  const attempt = await relayAttempt(
    { token: "not-a-telegram-token", state: ownerState },
    accepted,
  );
  assert.equal(attempt.failure, "token_invalid");
  assert.equal(attempt.calls.length, 0);
});

test("a relay before the owner has opened the chat reports the unknown chat", async () => {
  const missing = await relayAttempt({ token: VALID_TOKEN }, accepted);
  assert.equal(missing.failure, "owner_chat_unknown");

  const unparsable = await relayAttempt(
    { token: VALID_TOKEN, state: "{not json" },
    accepted,
  );
  assert.equal(unparsable.failure, "owner_chat_unknown");

  const chatless = await relayAttempt(
    { token: VALID_TOKEN, state: JSON.stringify({ ownerChatId: "4242" }) },
    accepted,
  );
  assert.equal(chatless.failure, "owner_chat_unknown");
  assert.equal(chatless.calls.length, 0);
});

/**
 * The rejection Telegram actually sends: the documented JSON envelope, not a
 * plain-text body. `parameters.retry_after` is the only statement of how long
 * the chat is closed for, so the fixture carries it and the assertions require
 * it to survive into the reported failure.
 *
 * https://core.telegram.org/bots/api#making-requests
 */
const tooManyRequests = (retryAfter: number): Response =>
  new Response(
    JSON.stringify({
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfter}`,
      parameters: { retry_after: retryAfter },
    }),
    { status: 429 },
  );

test("a rejected send reports Telegram's own error envelope, not a bare status", async () => {
  const attempt = await relayAttempt({ token: VALID_TOKEN, state: ownerState }, () =>
    tooManyRequests(3),
  );
  assert.equal(attempt.failure, "send_failed");
  assert.match(attempt.message, /429/);
  assert.match(attempt.message, /Too Many Requests: retry after 3/);
  assert.match(
    attempt.message,
    /retry after 3s/,
    "the documented wait is the only actionable part of a rate-limit rejection",
  );
});

test("a rejection whose body is not the documented envelope still names the status", async () => {
  const attempt = await relayAttempt(
    { token: VALID_TOKEN, state: ownerState },
    () => new Response("<html>bad gateway</html>", { status: 502 }),
  );
  assert.equal(attempt.failure, "send_failed");
  assert.match(attempt.message, /502/);
});

test("a report rejected partway through names what already reached the owner", async () => {
  const report = Array.from({ length: 200 }, () =>
    "- ".concat("x".repeat(80)),
  ).join("\n");
  const chunks = ownerRelayChunks(report);
  assert.ok(chunks.length > 1, "the fixture must be long enough to chunk");
  const replies = [accepted(), tooManyRequests(5)];
  const attempt = await relayAttempt(
    { token: VALID_TOKEN, state: ownerState },
    () => replies.shift() ?? accepted(),
    report,
  );
  assert.equal(attempt.failure, "send_failed");
  assert.equal(
    attempt.calls.length,
    2,
    "a rejected part stops the relay instead of pushing the rest into a closed chat",
  );
  assert.match(attempt.message, new RegExp(`part 2 of ${chunks.length} failed`));
  assert.match(
    attempt.message,
    /1 already delivered/,
    "reporting the whole report as undelivered repeats text the owner already has",
  );
  assert.match(attempt.message, /retry after 5s/);
});

test("a send Telegram answers with ok:false is a failure, not a delivery", async () => {
  const attempt = await relayAttempt(
    { token: VALID_TOKEN, state: ownerState },
    () =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
        status: 200,
      }),
  );
  assert.equal(attempt.failure, "send_failed");
});

test("a configured relay sends the owner chat rendered HTML", async () => {
  const attempt = await relayAttempt(
    { token: VALID_TOKEN, state: ownerState },
    accepted,
    "**Needs you**\n\n- issuance 237 restack is unowned",
  );
  assert.equal(attempt.failure, undefined, attempt.message);
  assert.equal(attempt.calls.length, 1);
  const [call] = attempt.calls;
  assert.match(call?.url ?? "", /^https:\/\/api\.telegram\.org\/bot123456789:/);
  assert.match(call?.url ?? "", /\/sendMessage$/);
  assert.equal(call?.body.chat_id, 4_242);
  assert.equal(call?.body.parse_mode, "HTML");
  assert.match(String(call?.body.text), /<b>Needs you<\/b>/);
});

test("a report longer than one Telegram message is sent as several", async () => {
  const report = Array.from({ length: 200 }, () =>
    "- ".concat("x".repeat(80)),
  ).join("\n");
  const attempt = await relayAttempt(
    { token: VALID_TOKEN, state: ownerState },
    accepted,
    report,
  );
  assert.equal(attempt.failure, undefined, attempt.message);
  assert.ok(attempt.calls.length > 1, "an oversized report must reach the owner in full");
  assert.equal(attempt.calls.length, ownerRelayChunks(report).length);
});

test("a report pointing at several links suppresses the preview card", () => {
  const [many] = ownerRelayChunks(
    "- [237](https://example.com/237)\n- [1091](https://example.com/1091)",
  );
  assert.equal(hasMultipleLinks(many ?? ""), true);
});

test("a report pointing at one link keeps its preview", () => {
  const [one] = ownerRelayChunks("see [237](https://example.com/237)");
  assert.equal(hasMultipleLinks(one ?? ""), false);
  assert.equal(hasMultipleLinks("no links at all"), false);
});

test("relayed owner reports render structure instead of arriving as prose", () => {
  const [chunk] = ownerRelayChunks(
    [
      "**Needs you**",
      "",
      "- issuance 237 restack is unowned",
      "- pins live in `ci.yaml`",
      "",
      "[PR 1091](https://github.com/example/repo/pull/1091)",
    ].join("\n"),
  );
  assert.ok(chunk?.includes("<b>Needs you</b>"), "bold must reach Telegram as markup");
  assert.ok(chunk?.includes("<code>ci.yaml</code>"), "inline code must reach Telegram as markup");
  assert.ok(
    chunk?.includes('<a href="https://github.com/example/repo/pull/1091">PR 1091</a>'),
    "links must reach Telegram as anchors so a PR is one tap away",
  );
  assert.ok(chunk?.includes("\n- issuance 237 restack is unowned"), "line structure survives");
});

test("relayed reports escape owner text that would otherwise be markup", () => {
  const [chunk] = ownerRelayChunks("worker <2> reported a & b");
  assert.equal(chunk, "worker &lt;2&gt; reported a &amp; b");
});

test("a report longer than one Telegram message splits on rendered lines", () => {
  const line = "- ".concat("x".repeat(80));
  const chunks = ownerRelayChunks(Array.from({ length: 200 }, () => line).join("\n"));
  assert.ok(chunks.length > 1, "an oversized report must be chunked");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4_000, "every chunk stays inside the Telegram limit");
    assert.ok(!chunk.startsWith("x"), "a chunk boundary must not fall mid-line");
  }
});
