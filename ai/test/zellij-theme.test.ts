import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("Zellij keeps the explicitly restored archeofuturist chrome", () => {
  const config = read("../../zellij/config.kdl");
  assert.match(config, /^theme\s+"archeofuturism"/m);
  assert.match(config, /^theme_dark\s+"archeofuturism"/m);
  assert.match(config, /^theme_light\s+"archeofuturism"/m);
  assert.match(config, /pane_frames true[\s\S]*rounded_corners true/);
});
