# Prompt assets

Keep shared LLM prompt bases here. TypeScript owns typed runtime assembly;
project instructions and current evidence supply task-specific requirements. Do
not add language, framework, or business-domain case catalogues to the generic
classifier policy.

## Classifier assembly

`extensions/classified-workflows/lifecycle.ts` assembles one classifier input
from these text fragments; the files do not run Git hooks or start separate
model calls.

| Asset                                | Use                                                     |
| ------------------------------------ | ------------------------------------------------------- |
| `classifier-policy.md`               | Generic authority, evidence, safety, and decision rules |
| `classifier-hook-authority.md`       | Guidance that configured Git hooks own their checks     |
| `classifier-enforce-linked-hooks.md` | Linked-worktree hook guidance                           |
| `classifier-enforce-main-hooks.md`   | Main-worktree hook guidance                             |
| `classifier-request-guidance.md`     | How to interpret task blocker evidence                  |

The builder replaces `LINKED_WORKTREE_HOOKS` and `MAIN_WORKTREE_HOOKS` in
trusted base text before appending runtime context and the untrusted subject.
Strings supplied by a user, tool, or model remain literal input, even when they
resemble a template marker.

The managed `git-hook-authority` flag accepts only `enforce`. Retired `off` and
`shadow` configurations return an explicit error before classifier dispatch;
they neither select an older policy nor silently change configuration. Existing
request metadata and callable exports remain compatible with loaded consumers,
but request fields cannot restore retired policy.

Missing assets must fail the existing execution boundary, never fall back to an
empty policy.

## Editing

Use `deno fmt ai/pi/prompts` for Markdown. Review the complete saved assets with
an independent critic before treating an editorial pass as finished. Bind review
to the saved content and recheck it after changes. Rendering tests must cover
actual runtime interpolation and literal handling of untrusted data; a text
snapshot alone does not prove classifier behavior.
