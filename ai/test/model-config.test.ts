import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8");
const settings = JSON.parse(readFileSync(new URL("../pi.settings.json", import.meta.url), "utf8"));

test("Codex Sol uses Pi's authoritative built-in context metadata", () => {
  assert.doesNotMatch(
    home,
    /providers\."openai-codex"\.modelOverrides\."gpt-5\.6-sol"\.contextWindow/,
  );
});

test("parent Codex turns use bounded sustained-overload retries", () => {
  assert.deepEqual(settings.retry, { enabled: true, maxRetries: 5, baseDelayMs: 2000 });
});
