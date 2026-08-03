import assert from "node:assert/strict";
import test from "node:test";
import { ownerRelayChunks } from "./owner-telegram.ts";

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
