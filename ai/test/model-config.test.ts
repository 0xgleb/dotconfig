import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8");
const settings = JSON.parse(readFileSync(new URL("../pi.settings.json", import.meta.url), "utf8"));

test("managed Codex Sol metadata preserves the 1.05M working context override", () => {
  assert.match(
    home,
    /providers\."openai-codex"\.modelOverrides\."gpt-5\.6-sol"\.contextWindow = 1050000;/,
  );
  assert.doesNotMatch(
    home,
    /providers\."openai-codex"\.modelOverrides\."gpt-5\.6-sol"\.contextWindow = 372000;/,
  );
});

test("parent Codex turns use bounded sustained-overload retries", () => {
  assert.deepEqual(settings.retry, { enabled: true, maxRetries: 5, baseDelayMs: 2000 });
});
