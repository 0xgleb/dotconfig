# Prompt assets

Keep shared LLM prompt bases here. TypeScript owns typed runtime assembly;
project instructions and current evidence supply task-specific requirements. Do
not add language, framework, or business-domain case catalogues to the generic
classifier policy.

## Classifier assembly

`extensions/classified-workflows/lifecycle.ts` assembles these assets:

| Asset                                | Use                                                       |
| ------------------------------------ | --------------------------------------------------------- |
| `classifier-policy.md`               | Generic authority, evidence, safety, and decision rules   |
| `classifier-hook-authority.md`       | Enforcement prefix, used only in `enforce` mode           |
| `classifier-enforce-linked-hooks.md` | Linked-worktree hook guidance in `enforce` mode           |
| `classifier-enforce-main-hooks.md`   | Main-worktree hook guidance in `enforce` mode             |
| `classifier-legacy-linked-hooks.md`  | Linked-worktree hook guidance in `off` and `shadow` modes |
| `classifier-legacy-main-hooks.md`    | Main-worktree hook guidance in `off` and `shadow` modes   |
| `classifier-request-guidance.md`     | How to interpret task blocker evidence                    |

The enforce and legacy snippets are alternatives, not cumulative requirements.
The `LEGACY_LINKED_HOOKS` and `LEGACY_MAIN_HOOKS` template keys retain their
names for compatibility; the builder selects their replacements from the trusted
hook-authority mode.

Substitute markers in trusted base text before appending runtime context and the
untrusted subject. Strings supplied by a user, tool, or model remain literal
input, even when they resemble a template marker. Keep callable exports stable
while loaded consumers depend on them. Missing assets must fail the existing
execution boundary, never fall back to an empty policy.

## Editing

Use `deno fmt ai/pi/prompts` for Markdown. Review the complete saved assets with
an independent critic before treating an editorial pass as finished. Bind review
to the saved content and recheck it after changes. Rendering tests must cover
hook-mode selection, actual runtime interpolation, and literal handling of
untrusted data; a text snapshot alone does not prove classifier behavior.
