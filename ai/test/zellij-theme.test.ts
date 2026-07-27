import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const path = (relative: string): URL => new URL(relative, import.meta.url);
const read = (relative: string): string => readFileSync(path(relative), "utf8");

const CONFIG = "../../zellij/config.kdl";
const GHOSTTY = "../../ghostty/config.ghostty";

/** Ghostty's `iTerm2 Default` theme, which the shell config selects by name. */
const ITERM2_DEFAULT_BACKGROUND = "#000000";

/** Relative luminance per WCAG. */
const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

/** Above this a broad fill stops reading as a dark surface and starts glaring. */
const MAX_SURFACE_LUMINANCE = 0.05;

/**
 * Mode panels are small and must lift off the bar to keep their arrow tips, so
 * they get more headroom than a broad surface -- but stay far under zellij's
 * stock grey panel, which sits near 0.22 and was rejected as too bright.
 */
const MAX_PANEL_LUMINANCE = 0.14;

/**
 * Zellij draws each arrow tip as a glyph in the panel's own fill color on top of
 * the bar. Below roughly this contrast the tip stops being a visible silhouette
 * and the panels read as missing rather than as dark.
 */
const MIN_PANEL_CONTRAST = 2;

const contrast = (a: string, b: string): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [number, number];
  return (high + 0.05) / (low + 0.05);
};

const PANELS = ["ribbon_unselected", "ribbon_selected"];

/**
 * `base` is the line color of a pane frame -- a large, always-on shape. A neon
 * value there outlines every pane in a glow. Focus stays legible well below.
 */
const MAX_FRAME_LINE_LUMINANCE = 0.35;

const componentStyles = (config: string): ReadonlyMap<string, { base: string; background: string }> => {
  const found = new Map<string, { base: string; background: string }>();
  for (const [, component, base, background] of config.matchAll(
    /(\w+)\s*\{\s*base\s+"(#[0-9A-Fa-f]{6})"\s*\n\s*background\s+"(#[0-9A-Fa-f]{6})"/g,
  )) {
    found.set(component as string, { base: base as string, background: background as string });
  }
  return found;
};

const styleOf = (component: string): { base: string; background: string } => {
  const style = componentStyles(read(CONFIG)).get(component);
  assert.ok(style, `zellij config must define ${component}`);
  return style;
};

/**
 * Zellij live-reloads config.kdl, so a theme defined inline reaches sessions
 * that are already attached. A theme in themes/ only loads at session start,
 * and a selected-but-missing one silently falls back to zellij's light default
 * while `zellij setup --check` still reports the config well defined. Keeping
 * the definition here is what makes styling edits land without a restart.
 */
test("the selected theme is defined inline so running sessions pick it up", () => {
  const config = read(CONFIG);
  const selected = config.match(/^theme\s+"([^"]+)"/m);
  assert.ok(selected, "zellij config must select a theme");

  const name = selected[1] as string;
  assert.match(config, new RegExp(`themes\\s*\\{[\\s\\S]*?\\b${name}\\s*\\{`), `${name} must be defined in config.kdl`);
  assert.ok(
    !existsSync(path("../../zellij/themes")),
    "a themes/ directory would compete with the inline definition and only load at session start",
  );
});

test("the bar sits on exactly the terminal background, with no step at the edge", () => {
  const ghostty = read(GHOSTTY);
  const explicit = ghostty.match(/^background\s*=\s*(#[0-9A-Fa-f]{6})/m);
  const terminal = explicit ? (explicit[1] as string) : ITERM2_DEFAULT_BACKGROUND;

  if (!explicit) assert.match(ghostty, /^theme\s*=\s*iTerm2 Default$/m, "terminal background assumption changed");

  assert.equal(
    styleOf("text_unselected").background.toUpperCase(),
    terminal.toUpperCase(),
    "a bar fill that differs from the terminal makes the edge of zellij step between two blacks",
  );
});

/**
 * The status bar draws its mode panels as arrow-tipped ribbons. The arrow shape
 * is only visible where the ribbon fill differs from the bar behind it, so a
 * ribbon painted in the bar's own color does not merely look flat -- the panels
 * disappear.
 */
test("mode panels keep an arrow silhouette against the bar", () => {
  const bar = styleOf("text_unselected").background;
  for (const component of PANELS) {
    const fill = styleOf(component).background;
    assert.ok(luminance(fill) > luminance(bar), `${component} must sit above the bar, not below it`);
    assert.ok(
      contrast(fill, bar) >= MIN_PANEL_CONTRAST,
      `${component} fill ${fill} contrasts the bar only ${contrast(fill, bar).toFixed(2)}:1, so its arrow tips vanish`,
    );
  }
});

test("mode panels stay well under the stock grey that was rejected", () => {
  for (const component of PANELS) {
    const fill = styleOf(component).background;
    assert.ok(
      luminance(fill) <= MAX_PANEL_LUMINANCE,
      `${component} fill ${fill} is drifting back toward the bright grey panel`,
    );
  }
});

test("the panels form a depth ramp rather than one flat repaint", () => {
  const bar = luminance(styleOf("text_unselected").background);
  const unselected = luminance(styleOf("ribbon_unselected").background);
  const selected = luminance(styleOf("ribbon_selected").background);

  assert.ok(bar < unselected && unselected < selected, "expected bar < unselected panel < selected panel");
});

test("no broad chrome surface is a bright panel", () => {
  const panelFills = new Set(PANELS.map((component) => styleOf(component).background.toUpperCase()));
  const bright = [...componentStyles(read(CONFIG))]
    .filter(([component]) => !PANELS.includes(component))
    .map(([, { background }]) => background)
    .filter((color) => !panelFills.has(color.toUpperCase()) && luminance(color) > MAX_SURFACE_LUMINANCE);

  assert.deepEqual([...new Set(bright)], [], "a broad fill this light is the glare the user rejected");
});

test("pane frames stay dark instead of outlining the session in neon", () => {
  for (const component of ["frame_selected", "frame_highlight"]) {
    const line = styleOf(component).base;
    assert.ok(
      luminance(line) <= MAX_FRAME_LINE_LUMINANCE,
      `${component} line ${line} is bright enough to read as a glowing frame`,
    );
  }
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
  // The terminal's own background is shared ground between the two, not drift.
  palette.add(ITERM2_DEFAULT_BACKGROUND);

  const themeBlock = read(CONFIG).match(/themes\s*\{[\s\S]*\n\}/);
  assert.ok(themeBlock, "expected an inline themes block");

  const foreign = [...(themeBlock[0] as string).matchAll(/"(#[0-9A-Fa-f]{6})"/g)]
    .map(([, color]) => (color as string).toUpperCase())
    .filter((color) => !palette.has(color));

  assert.deepEqual(
    [...new Set(foreign)],
    [],
    "zellij and Pi sit in the same window; a color in one and not the other reads as two different programs",
  );
});

test("zellij keeps the arrow separators and the rounded pane-frame treatment", () => {
  const config = read(CONFIG);
  assert.match(config, /^pane_frames true/m);
  assert.match(config, /ui \{[\s\S]*?pane_frames \{[\s\S]*?rounded_corners true/);
  assert.doesNotMatch(config, /^simplified_ui true/m, "simplified_ui strips the arrow separators from the mode panels");
});
