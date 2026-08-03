import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = readFileSync(new URL("../../zellij/config.kdl", import.meta.url), "utf8");

test("Zellij leaves Alt+Up available for Pi queued-message editing", () => {
  assert.doesNotMatch(config, /bind\s+"Alt up"/);
  assert.match(config, /Alt up is reserved for inner applications/);
});
