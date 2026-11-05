---
name: code-style-inspector
description: Auto-run during code reviews and audits in any language to check readable names, declaration and statement spacing, import qualification, line length including embedded SQL/JSON, and copied-definition provenance. Skip prose-only changes.
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
   and surrounding code. Assess readability at the use site, not just namespace
   collisions; a diff hunk alone may omit necessary context.
2. Check the language-independent rules below using the language's actual
   namespace semantics. Honor explicit project or owner exceptions.
3. Report the location, violated rule, concrete repair and any real exception.
   Return no findings only after complete coverage; identify inaccessible or
   unread source rather than claiming it passed.

Use the active harness's native read/search tools. Portable tool names in the
metadata do not require installing tools or changing the review boundary.

## Checks

### Separate declarations and meaningful phases

Separate independent declarations with blank lines, including consecutive
`const`-bound helper functions. Spacing inside their bodies does not substitute
for spacing between declarations.

Within larger bodies, separate meaningful phases: a completed operation chain
from substantial result handling, or validation from subsequent work. Keep tiny
two–three-line bodies compact; an assertion followed by a return does not
mechanically require an intervening blank line. Do not space every statement or
rewrite formatter-controlled layout by taste.

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
break a required module API. Language-specific import restrictions belong to the
corresponding language inspector.

### Use readable names and line lengths

Names should communicate a value's role at the use site. Flag unclear names and
unexplained abbreviations, not the absence of a newtype or a preference for a
different domain model. Domain types, newtypes and opaque-versus-primitive
representation choices belong to `strong-typing-inspector`, whether or not that
lane runs alongside this one. Language-specific representation mechanics belong
to the corresponding language inspector.

Check long embedded SQL queries, JSON snippets and other code that the
configured formatter does not lay out. Use the project's line-length rule where
one exists; otherwise require a readable structure rather than inventing a
numeric limit. Preserve query behavior, exact wire bytes and fixtures whose
layout is part of their contract; propose a layout that does not change those
semantics.

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
