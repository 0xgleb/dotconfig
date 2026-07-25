import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const path = (relative: string): URL => new URL(relative, import.meta.url);
const read = (relative: string): string => readFileSync(path(relative), "utf8");

const CONFIG = "../../zellij/config.kdl";
const THEME = "../../zellij/themes/archeofuturism.kdl";

/**
 * Zellij resolves `theme "name"` against its themes directory and silently
 * falls back to the built-in default when the definition is missing. That
 * default paints the tab bar and status bar with a light grey fill, which is
 * the "retina burning white" chrome the user rejected. A reference without a
 * definition is therefore a visual regression, not a harmless dangling name.
 */
const themeNameFrom = (config: string, key: string): string => {
  const match = config.match(new RegExp(`^${key}\\s+"([^"]+)"`, "m"));
  assert.ok(match, `zellij config must set ${key}`);
  return match[1] as string;
};

/** Relative luminance per WCAG; zellij chrome must stay far below any light surface. */
const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

const MAX_SURFACE_LUMINANCE = 0.05;

const backgroundsByComponent = (theme: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  for (const [, component, background] of theme.matchAll(
    /(\w+)\s*\{\s*base\s+"#[0-9A-Fa-f]{6}"\s*\n\s*background\s+"(#[0-9A-Fa-f]{6})"/g,
  )) {
    found.set(component as string, background as string);
  }
  return found;
};

test("the zellij theme selected by config actually exists on disk", () => {
  const config = read(CONFIG);
  const selected = themeNameFrom(config, "theme");

  assert.equal(selected, "archeofuturism");
  assert.equal(themeNameFrom(config, "theme_dark"), selected);
  assert.equal(themeNameFrom(config, "theme_light"), selected);

  assert.ok(
    existsSync(path(THEME)),
    `zellij/config.kdl selects "${selected}" but zellij/themes/${selected}.kdl is missing, so zellij falls back to its light default chrome`,
  );
  assert.match(read(THEME), new RegExp(`^\\s*${selected}\\s*\\{`, "m"));
});

test("every zellij chrome surface stays on the black archeofuturist base", () => {
  const backgrounds = backgroundsByComponent(read(THEME));

  for (const component of ["text_unselected", "text_selected", "ribbon_unselected", "ribbon_selected"]) {
    assert.ok(backgrounds.has(component), `theme must define ${component}`);
  }

  for (const [component, background] of backgrounds) {
    assert.ok(
      luminance(background) <= MAX_SURFACE_LUMINANCE,
      `${component} background ${background} is too light for the top and bottom chrome`,
    );
  }
});

test("the selected ribbon reads as a raised surface rather than a flat repaint", () => {
  const backgrounds = backgroundsByComponent(read(THEME));
  const base = backgrounds.get("text_unselected") as string;
  const selected = backgrounds.get("ribbon_selected") as string;

  assert.notEqual(selected, base, "selected chrome must be distinguishable from the bar it sits on");
  assert.ok(luminance(selected) > luminance(base), "the selected ribbon should sit above the bar, not below it");
});

test("zellij chrome draws from the same palette as the Pi theme", () => {
  const piTheme = JSON.parse(read("../pi/themes/archeofuturism.json")) as {
    vars: Record<string, string>;
    colors: Record<string, string>;
    export: Record<string, string>;
  };
  const palette = new Set(
    [...Object.values(piTheme.vars), ...Object.values(piTheme.colors), ...Object.values(piTheme.export)]
      .filter((value) => value.startsWith("#"))
      .map((value) => value.toUpperCase()),
  );

  const foreign = [...read(THEME).matchAll(/"(#[0-9A-Fa-f]{6})"/g)]
    .map(([, color]) => (color as string).toUpperCase())
    .filter((color) => !palette.has(color));

  assert.deepEqual(
    [...new Set(foreign)],
    [],
    "zellij and Pi sit in the same window; a color in one and not the other reads as two different programs",
  );
});

test("zellij keeps the requested rounded pane-frame treatment", () => {
  const config = read(CONFIG);
  assert.match(config, /^pane_frames true/m);
  assert.match(config, /ui \{[\s\S]*?pane_frames \{[\s\S]*?rounded_corners true/);
});
