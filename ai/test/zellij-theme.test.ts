import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("Zellij top and bottom chrome stay on the black archeofuturist surface", () => {
  const config = read("../../zellij/config.kdl");
  const theme = read("../../zellij/themes/archeofuturism.kdl");

  assert.match(config, /theme "archeofuturism"/);
  assert.match(config, /theme_dark "archeofuturism"/);
  assert.match(config, /theme_light "archeofuturism"/);
  assert.match(theme, /ribbon_selected \{[\s\S]*?background "#080B1A"/);
  assert.match(theme, /ribbon_unselected \{[\s\S]*?background "#080B1A"/);
  assert.doesNotMatch(theme, /ribbon_(?:selected|unselected) \{[\s\S]*?background "#(?:FFFFFF|E8F6FF)"/i);
});
