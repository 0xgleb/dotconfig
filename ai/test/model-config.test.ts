import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8");

test("managed Codex Sol metadata matches the provider-specific 372k contract", () => {
  assert.match(
    home,
    /providers\."openai-codex"\.modelOverrides\."gpt-5\.6-sol"\.contextWindow = 372000;/,
  );
  assert.doesNotMatch(
    home,
    /providers\."openai-codex"\.modelOverrides\."gpt-5\.6-sol"\.contextWindow = 1050000;/,
  );
});
