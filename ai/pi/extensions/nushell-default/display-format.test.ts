import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"
import { nushellToolPreviewLines } from "./core.ts"
import { breakAtNushellBoundaries } from "./display-boundaries.ts"
import { formatCommandForDisplay } from "./display-format.ts"

test("reflows a long loop list inside an authored multiline script", () => {
  const script =
    'for p in ["first long path" "second long path"] {\n  print $p\n}'
  assert.equal(
    breakAtNushellBoundaries(script, 28),
    'for p in [\n  "first long path"\n  "second long path"\n] {\n  print $p\n}',
  )
})

test("expands a simple braced if inside a multiline loop", () => {
  const script =
    'for p in [one two] {\n  if true { print "long message"; print $p }\n}'
  assert.equal(
    breakAtNushellBoundaries(script, 28),
    'for p in [one two] {\n  if true {\n    print "long message";\n    print $p\n  }\n}',
  )
})

test("reflows a parenthesized condition and a closure within authored nesting", () => {
  const script =
    'for p in [one two] {\n  if ($p == "one") { print "long message"; print $p }\n  ls | where {|row| $row.name =~ "long-pattern" }\n}'
  assert.equal(
    breakAtNushellBoundaries(script, 36),
    'for p in [one two] {\n  if ($p == "one") {\n    print "long message";\n    print $p\n  }\n  ls | where {|row|\n    $row.name =~ "long-pattern"\n  }\n}',
  )
})

test("preserves authored indentation in multiline previews", () => {
  const script =
    "for w in [42 140] {\n  with-env {MODE: 'fixture'} {\n    print $w\n  }\n}"
  assert.equal(
    formatCommandForDisplay(script, () =>
      script.replace("    print", "  print"),
    ),
    script,
  )
})

test("formats nested Nushell for display and falls back to exact input", () => {
  const raw =
    'with-env {MODE: "fixture"} { [1 2] | each {|x| $x + 1 }; assert true }'
  const formatted =
    'with-env { MODE: "fixture" } {\n  [1 2] | each {|x| $x + 1 }\n  assert true\n}'
  assert.equal(
    formatCommandForDisplay(raw, input => {
      assert.equal(input, raw)
      return formatted
    }),
    formatted,
  )
  assert.equal(
    formatCommandForDisplay(raw, () => undefined),
    raw,
  )
})

test("quoted GraphQL punctuation survives preview preprocessing", () => {
  const query = '"query { repository { name } }; | literal"'
  const command = `gh api graphql -f query=${query}`
  assert.equal(
    breakAtNushellBoundaries(`${command} | get data`, 32),
    `${command}\n  | get data`,
  )
})

test("expanded previews retain every character of a long quoted literal", () => {
  const raw = 'gh api graphql -f query="a  long literal with 界 and spaces"'
  const { commandLines } = nushellToolPreviewLines(
    raw,
    undefined,
    13,
    undefined,
    undefined,
    true,
  )
  assert.equal(commandLines.map(stripVTControlCharacters).join(""), raw)
})

test("an oversized GraphQL literal does not introduce continuation rows", () => {
  const command = `gh api graphql -f query="${"fragment with spaces ".repeat(8)}"`
  const { commandLines } = nushellToolPreviewLines(command, undefined, 42)
  assert.equal(commandLines.length, 1)
  assert.match(stripVTControlCharacters(commandLines[0] ?? ""), /…\s*$/u)
})

test("long where closures preserve their parameter header and block indentation", () => {
  const command = 'ls | where {|row| $row.name =~ "long-pattern" }'
  assert.equal(
    breakAtNushellBoundaries(command, 16),
    'ls\n  | where {|row|\n    $row.name =~ "long-pattern"\n  }',
  )
})

test("expanding a closure keeps a pipeline header that already fits", () => {
  const command =
    '$source | lines | enumerate | where {|row| $row.item =~ "long-pattern" }'
  assert.equal(
    breakAtNushellBoundaries(command, 50),
    '$source | lines | enumerate | where {|row|\n  $row.item =~ "long-pattern"\n}',
  )
})

test("a closed block separates an independent statement, not its next pipeline stage", () => {
  const block = 'ls | where {|row| $row.name =~ "long-pattern" }'
  const formatted = breakAtNushellBoundaries(`${block}; print done`, 16)
  assert.match(formatted, /\n  \};\n\nprint done$/u)
  assert.match(
    breakAtNushellBoundaries(`${block} | length`, 16),
    /\n  \}\n  \| length$/u,
  )
})

test("blank rows surround a continued pipeline only at statement boundaries", () => {
  assert.equal(
    breakAtNushellBoundaries(
      "print before; ls | get name | str upcase; print after",
      20,
    ),
    "print before;\n\nls\n  | get name\n  | str upcase;\n\nprint after",
  )
})

test("long external arguments are separated from neighboring statements", () => {
  assert.equal(
    breakAtNushellBoundaries(
      "print before; ^echo alpha bravo charlie; print after",
      20,
    ),
    "print before;\n\n(^echo\n  alpha\n  bravo\n  charlie\n);\n\nprint after",
  )
})

test("a long simple external invocation uses Nushell multiline arguments", () => {
  assert.equal(
    breakAtNushellBoundaries("^printf fixture alpha bravo charlie", 24),
    "(^printf\n  fixture\n  alpha\n  bravo\n  charlie\n)",
  )
})

test("quoted regex escapes do not hide the real pipeline boundary", () => {
  const command = String.raw`ls | where name =~ '^foo\.[ab|c];{2}$'`
  assert.equal(
    breakAtNushellBoundaries(command, 20),
    String.raw`ls
  | where name =~ '^foo\.[ab|c];{2}$'`,
  )
})

test("unchanged formatter output uses Nushell boundaries when it does not fit", () => {
  const raw =
    'with-env {MODE: "fixture"} { [1 2 3 4] | each {|x| $x + 100 }; assert true; print "fixture done" }'
  const { commandLines } = nushellToolPreviewLines(raw, undefined, 45)
  assert.ok(commandLines.some(line => line.trim() === "assert true;"))
  assert.ok(commandLines.some(line => line.trim() === "}"))
  assert.ok(commandLines.every(line => line.length <= 45))
  const wide = nushellToolPreviewLines(raw, undefined, 140)
  assert.equal(wide.header, "󰆍 Nushell")
  assert.deepEqual(wide.commandLines, [raw])
})
