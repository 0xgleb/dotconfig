---
name: code-style-inspector
description: Auto-run during code reviews and audits in any language to check logical spacing, import scope, readable qualification, domain identifiers and copied-definition provenance. Skip prose-only changes.
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Code style inspection

Find concrete violations of shared or project code conventions, not personal
formatting preferences. This is a read-only review lane; the calling workflow
owns fixes and publication.

## Review procedure

1. Use the engine's supplied diff and source identity. An audit's all-additions
   diff makes all scoped standing code eligible. Read affected files, imports
   and relevant domain types. Assess meaning at the use site, not just namespace
   collisions; a diff hunk alone may omit necessary context.
2. Check the rules below using the language's actual namespace and typing
   semantics. Honor explicit project or owner exceptions.
3. Report the location, violated rule, concrete repair and any real exception.
   Return no findings only after complete coverage; identify inaccessible or
   unread source rather than claiming it passed.

Use the active harness's native read/search tools. Portable tool names in the
metadata do not require installing tools or changing the review boundary.

## Checks

### Separate logical steps

Require a blank line between distinct phases: after a completed operation chain
before handling its result, after a match/switch before constructing a derived
value, and after a guard before the final return expression. This applies across
languages, including before `if let` and a final iterator expression in Rust.
Keep tightly related bindings together; do not insert a blank line before every
statement or rewrite formatter-controlled layout by taste.

### Import names at the right scope

Import distinctive dependencies at module/file scope when their short names
remain clear at the use site. Shorten paths to improve readability, not to
maximize the number of imports.

Preserve qualification when it explains an operation, type or error's origin
without making the reader jump back to the imports. A local name collision is
not required: `std::fs::read` identifies a filesystem operation, and
`eyre::Result` identifies its error contract. Generic names such as `Error`
remain crate-qualified even when no other `Error` is imported. Keep context such
as `fmt::Result` and `io::Result` rather than treating every unambiguous name as
a candidate for shortening.

Also preserve qualification for actual name collisions, associated/enum members
and required language/library namespaces. Do not introduce gratuitous aliases or
break a required module API. In Rust, function/block-local `use` is allowed only
for enum variants; other imports belong at module or test-module scope.

### Give identifiers domain types

An identifier stored or passed inside the application needs a distinct domain
type, not a bare string/number or an alias that remains interchangeable with it.
A lone chat/order/user ID can need a newtype even when no wrapper exists yet.
Use the language's newtypes, opaque/branded types or value objects; parse and
validate required invariants at the boundary. Raw wire/FFI fields are allowed
only at that boundary, not as an excuse to keep internal configuration or state
untyped. Do not wrap ordinary display text or loop counters.

When the engine also selects `strong-typing-inspector`, it owns detailed typing
findings; do not emit the same identifier finding twice.

### Cite copied definitions precisely

Copied upstream definitions need GitHub permalinks pinned to the full commit and
exact declaration lines. Rough repository paths, moving branches/tags, and
unsupported claims that a copy is audited or pinned are not provenance. This
rule concerns copied definitions, not every locally authored type or API
adapter.

## Reporting and fixes

Report verified convention violations even when they are easy to fix; do not
silently discard them as cosmetic. Use category `convention`, normally low
severity, with evidence and a specific repair. Do not inflate severity or invent
findings to fill a quota. A review-only caller receives findings, not edits.
Review-loop and audit callers re-verify and apply authorized fixes, then check
and re-review them; this inspector grants no additional mutation authority.

## Hard rules

- No behavior changes, namespace collisions, weakened validation or secret
  access.
- Preserve language/library requirements and explicit authorized exceptions.
- Do not duplicate compiler/formatter output already handled by the workflow.
- Rust error propagation and Cargo inheritance belong to the Rust inspector, not
  a cross-language ban on mapping errors or managing dependencies.
