import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("Zellij preserves its default theme instead of overriding terminal colors", () => {
  const config = read("../../zellij/config.kdl");
  assert.doesNotMatch(config, /^theme(?:_dark|_light)?\s+"archeofuturism"/m);
  assert.equal(existsSync(new URL("../../zellij/themes/archeofuturism.kdl", import.meta.url)), false);
});
