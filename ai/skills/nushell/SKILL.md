---
name: nushell
description: Write or debug Nushell (nu) one-liners and short scripts — especially parsing JSON / structured command output, pipelines, string interpolation, closures, safe field access, and capturing external-command results. Use whenever authoring a `nu -c '...'` command or a `.nu` script, or when a nushell command errors or behaves unexpectedly.
user-invocable: true
allowed-tools:
  - "Bash(nu *)"
  - "WebFetch(domain:nushell.sh)"
  - "Read"
  - "Grep"
  - "Glob"
---

# Nushell

Practical reference for writing correct Nushell (`nu`, v0.113) when shelling out
to process structured data. Nushell is **not bash with nicer syntax** — commands
pass typed values, not text. Internalize the mental model below before reaching
for bash habits, then use the idiom and gotcha tables.

Targets nushell 0.113.x. Confirm the local version with `nu --version`; if a
construct here misbehaves, check the official book before improvising:
`https://www.nushell.sh/book/` (and `https://www.nushell.sh/commands/` for
per-command docs).

## When to use nushell

Reach for nushell when the task is **structured-data processing** — parsing
JSON/CSV/TOML/YAML, filtering and reshaping tables, multi-step pipelines, or
correlating fields across records. It replaces ad-hoc `python3`/`jq`/`awk`/`perl`
scripts, which are forbidden.

Do **not** use it for plain file search/read — the dedicated tools (Grep, Glob,
Read) are better for that. Use nushell for the structured step, not as a generic
shell. Invoke `cargo`, `git`, or `gh` directly in the harness's native shell;
Pi's bash-named tool parses Nushell, not Bash.

## Invocation and the quoting trap

The single most common breakage is shell quoting. The reliable patterns:

1. **One-liner:** wrap the nu source in **single quotes** for bash, and use
   **double quotes** inside nu. They do not collide:
   ```bash
   nu -c 'open data.json | get items | length'
   nu -c '$"result: (2 + 2)"'
   ```
2. **nu source needs a literal single quote** (e.g. `$'...'` interpolation, or a
   single-quoted nu string): do **not** fight bash escaping. Write the script to
   a `.tmp/` file and run it:
   ```bash
   nu .tmp/process.nu
   ```
   (`.tmp/` is the sanctioned scratch dir — never write scratch to `/tmp`.)

Two things that look like nushell problems but are not:

- **`print` is a nushell builtin, not a bash one.** `print "x"` works *inside*
  `nu -c '...'`. Using `print` as a separator in a plain bash line fails with
  `print: command not found`. Keep nu code inside `nu -c`/a `.nu` file.
- **Piping another command's stdout into `nu` can deliver empty input.** Many
  CLIs (e.g. some `gh` paths) suppress or reformat stdout when not a
  TTY, so `some-cmd | nu -c 'from json | ...'` hits `from json` with empty input
  and errors `Pipeline empty`. **Fix:** redirect to a file first, then open it —
  `some-cmd > .tmp/out.json` then `nu -c 'open .tmp/out.json | ...'`. This is
  more robust than piping and lets you re-inspect the raw bytes.

## Parsing JSON / structured output (the primary use case)

```bash
# A file: open auto-parses by EXTENSION into structured data — no `from json`.
nu -c 'open response.json | get data.items'

# A string / piped text: it arrives as a STRING, so parse explicitly.
nu -c 'open --raw weird-ext.txt | from json | get version'
gh pr list --json number,title > .tmp/prs.json
nu -c 'open .tmp/prs.json | where number > 800 | select number title'

# Safe access to possibly-missing fields: append `?` -> null instead of error,
# then `default` for a fallback. This is THE trap when fields are optional.
nu -c 'open data.json | get items.0.id?'
nu -c 'open data.json | get config.timeout? | default 30'

# Per-row computed columns, then flatten to readable text.
nu -c 'open prs.json
       | each {|pr| $"#($pr.number) ($pr.title)" }
       | str join (char newline)'
```

Output shaping: `to json -r` (compact one line), `to json` (pretty, default),
`to csv`, `to text`, `to nuon`, or `| table` for a rendered grid. Pipe to
external tools through `to text` so they receive plain lines, not a bordered
table.

Debugging types: `... | describe` tells you whether a value is a `record`,
`table`, `list<string>`, `string`, etc. When a pipeline misbehaves, insert
`| describe` to see the actual shape.

## Mental model — internalize these

1. **Commands return typed VALUES, not text streams.** `ls` is a table,
   `open x.json` is a record/table, `echo "x"` is the string value `x`. Pipelines
   carry values. This is the biggest shift from bash.
2. **Only the last value of a block/script is returned/displayed.** `40; 50; 60`
   yields `60`; earlier results are discarded. Use `print` for deliberate
   side-channel output that must NOT become the return value.
3. **Two stages: parse-time then eval-time. There is no `eval`.** You cannot
   build a command string at runtime and run it. Paths for `source`/`use` must be
   `const` (parse-time), never `let` (runtime) — `let` there errors
   `not_a_constant`.
4. **Immutable by default.** `let` is fixed, `mut` is mutable, `const` is
   parse-time. Closures (passed to `each`/`where`/`reduce`) **cannot mutate an
   outer `mut`** (`Capture of mutable variable`). Accumulate with `reduce`, or use
   a `for` loop (a block, runs in current scope) when you truly need mutation.
5. **`;` is sequencing, not `&&`/`||`.** `&&`/`||` are not command-chaining
   operators; `and`/`or` are boolean operators on values. `;` also breaks `$in` —
   only `|` passes data downstream.

## Idiom reference

| Goal | Nushell |
|---|---|
| Field / index access | `$rec.key`, `$list.0`, `$table.col.2` (0-based) |
| Safe access (missing -> null) | `$rec.key?` &nbsp;or&nbsp; `get key?` &nbsp;or&nbsp; `get -o some.path` |
| Fallback for null/missing | `$rec.key? \| default "n/a"` |
| Dynamic key from a variable | `$rec \| get $keyvar` (dot syntax can't take a var) |
| Filter rows | `$t \| where status == "open"` &nbsp;/&nbsp; `where $it > 7` |
| Map | `$xs \| each {\|x\| $"item ($x)" }` |
| With index | `$xs \| enumerate \| each {\|e\| $"($e.index): ($e.item)" }` |
| Fold/accumulate | `$xs \| reduce --fold 0 {\|elt, acc\| $acc + $elt }` |
| Any / all | `$xs \| any {\|x\| $x > 0 }` / `all {\|x\| ... }` |
| Pick columns (keep table) | `$t \| select a b` |
| Extract values (lose table) | `$t \| get a` |
| Drop columns | `$t \| reject a b` |
| Sort / slice | `$t \| sort-by size \| first 5 \| skip 1` |
| String interpolation | `$"hello ($name), ($xs \| length) items"` |
| Concatenate | `$a ++ $b` (lists/strings) &nbsp;or&nbsp; `+` |
| Parse text -> table | `... \| lines \| split column "\|" a b c \| str trim` |
| Regex extract | `"v1.2" \| parse --regex '(?<maj>\d+)\.(?<min>\d+)'` |
| if / match (expressions) | `if $x > 0 { "pos" } else { "neg" }` |
| Env var, safe read | `$env.FOO? \| default "x"` ; set: `$env.FOO = "x"` |
| Scoped env | `with-env { TOKEN: $t } { ^tool fetch }` |

### `get` vs `select`

`get` returns the underlying **value** (a record/list/scalar); `select` returns
the **same structure type** (a table stays a one-row table). Use `get` to pull a
value to pipe onward, `select` to narrow a table while keeping headers. They are
not interchangeable — downstream code expecting a record breaks on a `select`
result and vice versa.

### Closures

Params are declared **inside** the braces: `{|elt| ... }`, `{|elt, acc| ... }`.
A bare `{}` is an empty **record**, not a closure — write `{|| ... }` to force an
empty closure. `$it` is the implicit current item, but only in row filters like
`where`; in `each`/`reduce` you name your own param.

### Calling external commands

```bash
nu -c '^curl -s https://api.example.com | from json | get results'
# Capture stdout + stderr + exit_code together; wrap externals in `do {}`:
nu -c 'let r = (do { ^my-tool --json } | complete)
       if $r.exit_code != 0 { error make {msg: $r.stderr} }
       $r.stdout | from json'
```

- `^name` forces the system binary when a nu builtin shadows it (`^ls` vs `ls`).
- Stderr prints to the screen and is **not** piped by default. Capture it with
  `complete`, or redirect: `o>` (stdout), `e>` (stderr), `o+e>` (both to a file),
  `o+e>|` (both into the next command). Discard with `| ignore`.
- Last exit code is `$env.LAST_EXIT_CODE` — there is no `$?`.

## Gotchas (the things that actually bite)

- **Missing field/index ERRORS by default.** Always `?` for optional data:
  `$x.field?`, `$x.5?`, `get path?`. Forgetting this turns an absent JSON field
  into a hard failure. (`get -i`/`--ignore-errors` is deprecated — use `?`/`-o`.)
- **Plain quotes do not interpolate.** `"hello $name"` is literal. Interpolate
  with `$"hello ($name)"` — `$` prefix, expression in **parentheses**. Field
  access and command calls inside a string MUST be parenthesized.
- **Single-quote interpolation `$'...'` processes no escapes** and cannot contain
  `'` or unmatched `()`. Use `$"..."` when you need `\n` or literal parens (`\(`).
- **`open` returns parsed data, not text.** Piping `open x.json | from json`
  double-parses and type-errors. Use `open --raw` when you need the string.
- **`split column` default names are `column0`, `column1`, ...** (0-based). Pass
  names: `split column "|" first last`.
- **`reduce` without `--fold` seeds from the first element** and runs one fewer
  time — wrong for products, joins, or empty lists. Pass `--fold <init>`.
- **`for`/`while`/`loop` are statements** — they return nothing and error with
  `Statement used in pipeline` if used in a pipeline. Use `each` to produce a
  value. `let r = (for x in [1 2] { $x })` is `null`, not a list.
- **Env / `cd` changes are block-scoped.** A change inside `do {}`/`each`/`for`
  reverts on block exit. A custom command needs `def --env` to mutate the
  caller's environment.
- **`$env.PATH` is a list**, not a colon string — `$env.PATH | append /x`, not
  concatenation. `$env` keys are case-insensitive.
- **Call commands space-separated**, never `greet("x")` — parens mean a
  sub-expression, not arguments. Spread a list into args with `...$list`.
- **Floats are approximate** (`10.2 * 5.1` -> `52.0199...`). Never use float
  equality for financial/precise values.

## Workflow

1. Decide nushell is the right tool (structured data, not plain search/read).
2. Get the data into a file when it comes from another CLI (`cmd > .tmp/x.json`),
   then `open` it — more robust than piping into `nu`.
3. Build the pipeline incrementally; insert `| describe` to confirm shapes.
4. Use `?` on every possibly-missing field and `default` for fallbacks.
5. Run it (`nu -c '...'` or `nu .tmp/script.nu`); never paste nu syntax into a
   bare bash line.

## Hard rules

1. Never paste nushell syntax into a plain bash command line — it must run inside
   `nu -c '...'` or a `.nu` file. `print`, `each`, `$"..."`, cell paths are nu,
   not bash.
2. Always use `?` (or `get -o`) for fields that may be absent; never assume a key
   exists. Financial/precise data must not rely on float equality.
3. Scratch files go under `.tmp/`, never `/tmp`.
4. nushell replaces ad-hoc `python3`/`jq`/`awk`/`perl` for structured data — do
   not introduce those; do not use nushell to replace Grep/Glob/Read for plain
   file work.
5. Verify constructs against `https://www.nushell.sh/book/` when unsure rather
   than guessing syntax — the language differs sharply from bash and from older
   nushell versions.

## Failure modes

- **`Pipeline empty` / `no input value`** — a `from json`/`from ...` got empty
  input, usually because the upstream CLI wrote nothing to a non-TTY pipe.
  Redirect to a file and `open` it instead of piping.
- **`cannot find column` / column-not-found** — a field is missing; add `?` to
  the cell path or use `default`.
- **`Statement used in pipeline`** — a `for`/`while`/`loop` is in a pipeline;
  switch to `each`.
- **`Capture of mutable variable`** — a closure tried to mutate an outer `mut`;
  use `reduce`/`each` return values or a `for` loop.
- **`not_a_constant`** — a `source`/`use` path used `let`; make it `const`.
- **`command not found: print` (in bash)** — nu syntax leaked onto a bash line;
  wrap it in `nu -c`.
