import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Either } from "effect";
import {
  decodeExtensionFrame,
  decodeHostFrame,
  MAX_TAB_SUMMARIES,
  MAX_TEXT_CHARS,
  resultMatchesAction,
  type ExtensionFrame,
  type HostFrame,
} from "./extension-protocol.ts";

const decoded = <A>(effect: Effect.Effect<A, unknown>): A => Effect.runSync(effect);

const rejected = <A>(effect: Effect.Effect<A, unknown>): boolean =>
  Either.isLeft(Effect.runSync(Effect.either(effect)));

const token = "a".repeat(48);

const controlCharacter = String.fromCharCode(0);

const hello = {
  version: 1,
  kind: "hello",
  token,
  profilePath: "/Users/example/.config/ai/pi/brave-operator-profile",
};

test("hello frames authenticate with a bounded provisioned token", () => {
  assert.deepEqual(decoded(decodeExtensionFrame(hello)), hello as ExtensionFrame);
  assert.ok(rejected(decodeExtensionFrame({ ...hello, token: "short" })));
  assert.ok(rejected(decodeExtensionFrame({ ...hello, token: `${token} ` })));
  assert.ok(rejected(decodeExtensionFrame({ ...hello, profilePath: "relative/profile" })));
  assert.ok(rejected(decodeExtensionFrame({ ...hello, injected: "field" })));
});

test("act frames correlate their parameters with the action", () => {
  const open = { version: 1, kind: "act", requestId: "req-1", action: "open", url: "https://example.com/" };
  const status = { version: 1, kind: "act", requestId: "req-2", action: "status" };
  assert.deepEqual(decoded(decodeHostFrame(open)), open as HostFrame);
  assert.deepEqual(decoded(decodeHostFrame(status)), status as HostFrame);
  assert.ok(rejected(decodeHostFrame({ ...open, url: undefined })));
  assert.ok(rejected(decodeHostFrame({ ...status, url: "https://example.com/" })));
  assert.ok(rejected(decodeHostFrame({ ...open, action: "shell" })));
  assert.ok(rejected(decodeHostFrame({ ...open, extra: true })));
});

test("overlay frames carry a bounded printable label and a typed phase", () => {
  const overlay = { version: 1, kind: "overlay", requestId: "req-1", phase: "start", label: "Opening example.com" };
  assert.deepEqual(decoded(decodeHostFrame(overlay)), overlay as HostFrame);
  assert.ok(rejected(decodeHostFrame({ ...overlay, phase: "blink" })));
  assert.ok(rejected(decodeHostFrame({ ...overlay, label: "x".repeat(121) })));
  assert.ok(rejected(decodeHostFrame({ ...overlay, label: `bad${controlCharacter}label` })));
});

test("result frames pair payloads with their action and stay bounded", () => {
  const statusResult = {
    version: 1,
    kind: "result",
    requestId: "req-2",
    outcome: "completed",
    payload: { action: "status", tabs: [{ title: "Example", url: "https://example.com/" }] },
  };
  const textResult = {
    version: 1,
    kind: "result",
    requestId: "req-3",
    outcome: "completed",
    payload: { action: "text", text: "page body" },
  };
  assert.deepEqual(decoded(decodeExtensionFrame(statusResult)), statusResult as ExtensionFrame);
  assert.deepEqual(decoded(decodeExtensionFrame(textResult)), textResult as ExtensionFrame);
  assert.ok(
    rejected(
      decodeExtensionFrame({
        ...textResult,
        payload: { action: "text", text: "x".repeat(MAX_TEXT_CHARS + 1) },
      }),
    ),
  );
  assert.ok(
    rejected(
      decodeExtensionFrame({
        ...statusResult,
        payload: {
          action: "status",
          tabs: Array.from({ length: MAX_TAB_SUMMARIES + 1 }, () => ({
            title: "t",
            url: "https://example.com/",
          })),
        },
      }),
    ),
  );
  assert.ok(
    rejected(
      decodeExtensionFrame({
        ...textResult,
        payload: { action: "text", text: "page body", command: "rm -rf" },
      }),
    ),
  );
});

test("failed results carry only a bounded error and no payload", () => {
  const failed = {
    version: 1,
    kind: "result",
    requestId: "req-4",
    outcome: "failed",
    error: "tab was closed before the action ran",
  };
  assert.deepEqual(decoded(decodeExtensionFrame(failed)), failed as ExtensionFrame);
  assert.ok(
    rejected(
      decodeExtensionFrame({ ...failed, payload: { action: "text", text: "smuggled" } }),
    ),
  );
  assert.ok(rejected(decodeExtensionFrame({ ...failed, error: "x".repeat(2_001) })));
});

test("unknown versions, kinds, and identifiers reject the whole frame", () => {
  assert.ok(rejected(decodeExtensionFrame({ ...hello, version: 2 })));
  assert.ok(rejected(decodeExtensionFrame({ version: 1, kind: "exec", requestId: "r" })));
  assert.ok(rejected(decodeHostFrame({ version: 1, kind: "act", requestId: "bad id", action: "status" })));
  assert.ok(rejected(decodeHostFrame("not a frame")));
  assert.ok(rejected(decodeExtensionFrame(null)));
});

test("completed results are accepted only for their originating action", () => {
  const openResult = decoded(
    decodeExtensionFrame({
      version: 1,
      kind: "result",
      requestId: "req-5",
      outcome: "completed",
      payload: { action: "open", url: "https://example.com/" },
    }),
  );
  if (openResult.kind !== "result") assert.fail("expected a result frame");
  assert.ok(resultMatchesAction(openResult, "open"));
  assert.ok(!resultMatchesAction(openResult, "text"));
  const failed = decoded(
    decodeExtensionFrame({
      version: 1,
      kind: "result",
      requestId: "req-6",
      outcome: "failed",
      error: "navigation refused",
    }),
  );
  if (failed.kind !== "result") assert.fail("expected a result frame");
  assert.ok(resultMatchesAction(failed, "open"));
});
