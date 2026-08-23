import assert from "node:assert/strict";
import test from "node:test";
import {
  decideHandshake,
  decideHello,
  decodeClientFrames,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  MAX_CLIENT_FRAME_BYTES,
  mintTransportToken,
  TRANSPORT_TOKEN_ENTROPY_BYTES,
  type HandshakeRequest,
} from "./extension-transport.ts";

const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const validHandshake: HandshakeRequest = {
  method: "GET",
  headers: {
    host: "127.0.0.1:7777",
    origin: extensionOrigin,
    upgrade: "websocket",
    connection: "keep-alive, Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  },
};

const maskFrame = (header: readonly number[], payload: Uint8Array): Uint8Array => {
  const mask = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const frame = new Uint8Array(header.length + 4 + payload.length);
  frame.set(Uint8Array.from(header), 0);
  frame.set(mask, header.length);
  payload.forEach((byte, index) => {
    frame[header.length + 4 + index] = byte ^ (mask[index % 4] ?? 0);
  });
  return frame;
};

const textFrame = (text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  assert.ok(payload.length < 126, "test helper only builds short frames");
  return maskFrame([0x81, 0x80 | payload.length], payload);
};

test("handshakes are accepted only for the provisioned extension origin", () => {
  const accepted = decideHandshake(validHandshake, extensionOrigin);
  assert.deepEqual(accepted, {
    outcome: "accepted",
    acceptKey: "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  });
  const rejectedOrigin = decideHandshake(
    { ...validHandshake, headers: { ...validHandshake.headers, origin: "https://example.com" } },
    extensionOrigin,
  );
  assert.equal(rejectedOrigin.outcome, "rejected");
  assert.equal(
    decideHandshake({ ...validHandshake, method: "POST" }, extensionOrigin).outcome,
    "rejected",
  );
  assert.equal(
    decideHandshake(
      { ...validHandshake, headers: { ...validHandshake.headers, "sec-websocket-version": "8" } },
      extensionOrigin,
    ).outcome,
    "rejected",
  );
  assert.equal(
    decideHandshake(
      { ...validHandshake, headers: { ...validHandshake.headers, "sec-websocket-key": undefined } },
      extensionOrigin,
    ).outcome,
    "rejected",
  );
  assert.equal(
    decideHandshake(
      { ...validHandshake, headers: { ...validHandshake.headers, "sec-websocket-key": "tooshort" } },
      extensionOrigin,
    ).outcome,
    "rejected",
  );
  assert.equal(
    decideHandshake(
      { ...validHandshake, headers: { ...validHandshake.headers, upgrade: "h2c" } },
      extensionOrigin,
    ).outcome,
    "rejected",
  );
});

test("masked client text frames decode and partial buffers are retained", () => {
  const hello = textFrame("hello");
  const partial = hello.slice(0, 3);
  const first = decodeClientFrames(partial, MAX_CLIENT_FRAME_BYTES);
  assert.equal(first.outcome, "frames");
  if (first.outcome !== "frames") return;
  assert.equal(first.events.length, 0);
  assert.equal(first.rest.length, partial.length);

  const both = new Uint8Array(hello.length + hello.length);
  both.set(hello, 0);
  both.set(hello, hello.length);
  const decoded = decodeClientFrames(both, MAX_CLIENT_FRAME_BYTES);
  assert.equal(decoded.outcome, "frames");
  if (decoded.outcome !== "frames") return;
  assert.deepEqual(decoded.events, [
    { kind: "text", text: "hello" },
    { kind: "text", text: "hello" },
  ]);
  assert.equal(decoded.rest.length, 0);
});

test("control frames surface as typed events", () => {
  const ping = maskFrame([0x89, 0x82], Uint8Array.from([0x01, 0x02]));
  const close = maskFrame([0x88, 0x80], new Uint8Array());
  const buffer = new Uint8Array(ping.length + close.length);
  buffer.set(ping, 0);
  buffer.set(close, ping.length);
  const decoded = decodeClientFrames(buffer, MAX_CLIENT_FRAME_BYTES);
  assert.equal(decoded.outcome, "frames");
  if (decoded.outcome !== "frames") return;
  assert.equal(decoded.events.length, 2);
  const pingEvent = decoded.events[0];
  assert.equal(pingEvent?.kind, "ping");
  if (pingEvent?.kind === "ping") {
    assert.deepEqual(Array.from(pingEvent.payload), [0x01, 0x02]);
  }
  assert.deepEqual(decoded.events[1], { kind: "close" });
});

test("protocol violations fail the whole connection", () => {
  const unmasked = Uint8Array.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.equal(decodeClientFrames(unmasked, MAX_CLIENT_FRAME_BYTES).outcome, "violation");
  const fragmented = maskFrame([0x01, 0x81], Uint8Array.from([0x68]));
  assert.equal(decodeClientFrames(fragmented, MAX_CLIENT_FRAME_BYTES).outcome, "violation");
  const binary = maskFrame([0x82, 0x81], Uint8Array.from([0x68]));
  assert.equal(decodeClientFrames(binary, MAX_CLIENT_FRAME_BYTES).outcome, "violation");
  const reserved = maskFrame([0xc1, 0x81], Uint8Array.from([0x68]));
  assert.equal(decodeClientFrames(reserved, MAX_CLIENT_FRAME_BYTES).outcome, "violation");
  const oversized = maskFrame([0x81, 0xfe, 0x00, 0x08], new Uint8Array(8));
  assert.equal(decodeClientFrames(oversized, 4).outcome, "violation");
});

test("server frames are unmasked and bounded", () => {
  const text = encodeTextFrame("ok");
  assert.deepEqual(Array.from(text), [0x81, 0x02, 0x6f, 0x6b]);
  const longText = encodeTextFrame("x".repeat(200));
  assert.deepEqual(Array.from(longText.slice(0, 4)), [0x81, 0x7e, 0x00, 0xc8]);
  assert.equal(longText.length, 4 + 200);
  const pong = encodePongFrame(Uint8Array.from([0x01]));
  assert.deepEqual(Array.from(pong), [0x8a, 0x01, 0x01]);
  assert.deepEqual(Array.from(encodeCloseFrame()), [0x88, 0x00]);
});

test("transport tokens are safe identifiers minted from sufficient entropy", () => {
  const entropy = new Uint8Array(TRANSPORT_TOKEN_ENTROPY_BYTES).fill(0xab);
  const token = mintTransportToken(entropy);
  assert.equal(token.length, TRANSPORT_TOKEN_ENTROPY_BYTES * 2);
  assert.match(token, /^[a-f0-9]+$/);
  assert.throws(() => mintTransportToken(new Uint8Array(8)));
});

test("hello admission requires the provisioned token and operator profile", () => {
  const provisioned = {
    token: mintTransportToken(new Uint8Array(TRANSPORT_TOKEN_ENTROPY_BYTES).fill(0x77)),
    profilePath: "/Users/example/.config/ai/pi/brave-operator-profile",
  };
  const hello = {
    version: 1,
    kind: "hello",
    token: provisioned.token,
    profilePath: provisioned.profilePath,
  };
  assert.deepEqual(decideHello(hello, provisioned), { outcome: "accepted" });
  assert.equal(
    decideHello({ ...hello, token: provisioned.token.replace("7", "8") }, provisioned).outcome,
    "rejected",
  );
  assert.equal(
    decideHello({ ...hello, profilePath: "/tmp/other-profile" }, provisioned).outcome,
    "rejected",
  );
  assert.equal(decideHello({ malformed: true }, provisioned).outcome, "rejected");
  assert.equal(
    decideHello(
      { version: 1, kind: "result", requestId: "r-1", outcome: "failed", error: "nope" },
      provisioned,
    ).outcome,
    "rejected",
  );
});
