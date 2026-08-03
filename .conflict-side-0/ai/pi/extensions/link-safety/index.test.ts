import assert from "node:assert/strict";
import test from "node:test";
import { exposeGraphiteUrls } from "./index.ts";

test("Graphite Markdown links render as unambiguous raw remote URLs", () => {
  assert.equal(
    exposeGraphiteUrls("Review [PR 1044](https://app.graphite.dev/github/pr/ST0x-Technology/st0x.liquidity/1044)."),
    "Review https://app.graphite.dev/github/pr/ST0x-Technology/st0x.liquidity/1044.",
  );
});

test("other links and code examples remain unchanged", () => {
  const source = [
    "Keep [docs](https://example.com/docs).",
    "Keep `[PR](https://app.graphite.dev/github/pr/o/r/1)` inline.",
    "```md",
    "[PR](https://app.graphite.dev/github/pr/o/r/2)",
    "```",
  ].join("\n");
  assert.equal(exposeGraphiteUrls(source), source);
});
