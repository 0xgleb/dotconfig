import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Effect } from "effect"

import {
  nushellCommandPreviewLines,
  nushellTableWidthPrefix,
  nushellToolPreviewLines,
  resolveNushellPath as resolveNushellPathEffect,
  resolveNushellTableWidth,
} from "./core.ts"

const resolveNushellPath = (
  ...args: Parameters<typeof resolveNushellPathEffect>
) => Effect.runSync(resolveNushellPathEffect(...args))

test("the rendered Nushell header is separated from the unbolded script", async () => {
  const { renderNushellCall } = await import("./index.ts")
  const theme = {
    fg: (color: string, text: string) => `${color}:${text}`,
    bold: (text: string) => `bold:${text}`,
  }
  let calls = 0
  const view = renderNushellCall({ command: "echo fixture" }, theme, script => {
    calls++
    assert.equal(script, "echo fixture")
    return "\u001b[32mecho\u001b[0m fixture"
  })
  const rows = view.render(42)
  view.render(140)
  assert.equal(calls, 1)
  assert.equal(rows[1], "")
  assert.equal(rows[2], "\u001b[32mecho\u001b[39m fixture")
})

test("syntax-aware continuation rows retain highlighting", async () => {
  const { renderNushellCall } = await import("./index.ts")
  const theme = { fg: (_color: string, text: string) => text, bold: String }
  const command = "echo fixture | str upcase"
  const rows = renderNushellCall({ command }, theme, script =>
    script
      .split("\n")
      .map(line => `\u001b[32m${line}\u001b[0m`)
      .join("\n"),
  ).render(18)
  assert.ok(rows.some(row => row.includes("\u001b[32m  | str upcase")))
  const clipped =
    renderNushellCall(
      { command: "echo abcdefghijklmnop" },
      theme,
      script => `\u001b[32m${script}\u001b[0m`,
    ).render(14)[2] ?? ""
  assert.match(clipped, /\u001b\[32m/)
  assert.doesNotMatch(clipped, /\u001b\[0m/)
})

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("multiline command previews use one shell prompt for the whole program", () => {
  assert.deepEqual(
    nushellCommandPreviewLines(
      "let package = 'pi-coding-agent'\n^nix build $package",
      80,
    ),
    ["ν let package = 'pi-coding-agent'", "  ^nix build $package"],
  )
})

test("command previews retain deliberate blank source lines without inventing prompts", () => {
  assert.deepEqual(nushellCommandPreviewLines("let a = 1\n\n$a", 80), [
    "ν let a = 1",
    "",
    "  $a",
  ])
})

test("narrow command previews wrap with visible continuation structure", () => {
  const width = 20
  const lines = nushellCommandPreviewLines(
    "^nix build --no-link .#darwinConfigurations.darwwwin.system",
    width,
  )

  assert.ok(lines.length > 1)
  assert.match(lines[0] ?? "", /^ν /)
  for (const line of lines.slice(1)) assert.match(line, /^  \S/)
  for (const line of lines) assert.ok(line.length <= width)
})

test("wide command previews stay on one line and timeout metadata is demoted", () => {
  const command = "^cargo test --workspace"
  const preview = nushellToolPreviewLines(command, 300, 80)

  assert.deepEqual(preview, {
    header: "󰆍 Nushell",
    commandLines: [command],
    timeoutLines: ["timeout 300s"],
  })
})

test("extremely narrow previews still honor the TUI width contract", () => {
  const lines = nushellCommandPreviewLines("abc", 1)
  assert.deepEqual(lines, ["a", "b", "c"])
  assert.ok(lines.every(line => line.length <= 1))
})

test("Nushell table width follows the live Pi terminal instead of the piped 80-column fallback", () => {
  assert.equal(resolveNushellTableWidth(160, undefined, undefined), 160)
  assert.equal(resolveNushellTableWidth(undefined, 160, undefined), 154)
  assert.equal(resolveNushellTableWidth(undefined, undefined, 120), 114)
  assert.equal(resolveNushellTableWidth(undefined, undefined, undefined), 80)
  assert.equal(resolveNushellTableWidth(Number.NaN, 7, undefined), 1)
  assert.equal(
    nushellTableWidthPrefix(154),
    "$env.config.hooks.display_output = { table --width 154 }",
  )
})

test("the injected display hook renders a wide table in a piped Nushell process", () => {
  const detail = "x".repeat(100)
  const command = `${nushellTableWidthPrefix(120)}
[[detail]; ['${detail}']]`
  const result = spawnSync(
    resolveNushellPath(process.env.HOME),
    ["-c", command],
    {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trimEnd().split(/\r?\n/)
  // `table --width` is a maximum, not forced padding. This one-column fixture
  // naturally renders at 108 columns; the piped 80-column fallback truncates it.
  assert.equal(lines[0]?.length, 108)
  assert.ok(lines.some(line => line.includes(detail)))
})

test("the renderer changes presentation without rewriting executed command bytes", () => {
  assert.match(
    source,
    /createBashToolDefinition\(ctx\.cwd,[\s\S]*?\)\.execute\([\s\S]*?params,/,
  )
  assert.match(
    source,
    /literal newlines instead of separating them with semicolons/,
  )
  assert.match(source, /latestNushellTuiWidth = width/)
  assert.match(
    source,
    /await new Promise<void>\(resolve => setImmediate\(resolve\)\)/,
  )
  assert.match(source, /latestNushellTuiWidth,[\s\S]*?process\.stdout\.columns/)
  assert.match(source, /process\.stdout\.columns/)
  assert.match(source, /process\.stderr\.columns/)
  assert.match(source, /commandPrefix: nushellTableWidthPrefix\(tableWidth\)/)
  assert.match(source, /createDirenvEnvironmentLoader/)
  assert.match(source, /await direnvLoader\.load/)
  assert.match(source, /spawnHook: context =>/)
  assert.match(source, /applyDirenvEnvironment\(context, exported\)/)
  assert.doesNotMatch(source, /commandPrefix:[^\n]*direnv/)
})
