---
name: new-skill
description: Create or update shared agent skills directly in ~/.config/ai/skills, with portable metadata, review, live-link verification and the repository's branch/PR delivery workflow.
user-invocable: true
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

# Shared skill changes

`~/.config` is the Git toplevel and main worktree for global skills and harness
configuration. Follow its `GLOBAL_AGENTS.md` and `AGENTS.md`; do not hand a
routine requested skill edit to another agent or substitute a scratch draft for
changing the canonical source.

## Procedure

1. Resolve the requested purpose and existing coverage. Skills live under
   `ai/skills/<kebab-case-name>/SKILL.md`. Read relevant skills before adding a
   duplicate. Update an existing skill when that is the requested change; never
   overwrite unrelated work. Ask only for genuinely missing decisions, not
   metadata the request already determines.
2. Verify main-worktree topology and the existing VCS workspace. For follow-up
   corrections to an unmerged change, continue its existing branch and PR;
   inspect later branches in its stack before changing guidance they may already
   supersede. A new prompt, session or reload is not a new work unit. Create a
   purpose-named branch only for independent work with no suitable ongoing
   branch. Preserve unrelated tracked, staged and untracked changes; use scoped
   file/hunk assignment. Do not create a worktree for isolation alone.
3. Edit the canonical skill directly. Use a precise activation description,
   concrete workflow and stopping conditions. Names use lowercase letters,
   digits and hyphens, at most 64 characters; descriptions are at most 1024
   characters. Avoid angle brackets in descriptions for portability.
4. Keep tool metadata narrow. It does not create capabilities: use available
   native equivalents while preserving scope, exclusions and mutation limits. No
   blanket shell/tool grants, secret access or unclassified workers.
5. When changing inspection criteria, wire the relevant shared review engine so
   review-loop and audit actually select them. Separate cross-language
   conventions from language-specific checks. Validate positive examples and
   genuine exceptions; do not add rules that suppress necessary context.
6. Obtain independent criticism of the actual saved prose through power-unslop,
   apply valid repairs and verify the exact final content. Do not demand a
   full-draft approval ceremony unless the owner requested one or a real
   unresolved policy choice prevents safe implementation.
7. Verify the file resolves through Pi's live skill directory and any other
   enabled harness links relevant to the request. Do not recreate a skill in a
   per-harness directory. Home Manager's generated resources may need a separate
   authorized activation; a source edit does not authorize a host rebuild.
8. Commit and push coherent validated units as work proceeds. Update the
   existing PR when continuing its work; otherwise open a draft PR with the
   first checkpoint through the repository's workflow. Keep its description
   current. Mark it ready once the requested scope and verification are
   complete. This routine delivery is authorized by the scoped global-resource
   request; do not ask again whether to push. Never merge or override branch
   protection.
9. Use the registered reload tool after changing live Pi resources. Verify
   discovery/activation; do not inject slash commands or keystrokes into the
   owner's editor. Release any temporary task role when the work is complete.

## Failure handling

Missing context, broken live links or unavailable validation must be reported
precisely, not hidden behind a clean claim. Preserve completed evidence and
continue independent authorized work. A genuine platform blocker follows the
repository's owner-consulted investigation and repair procedure; it does not
transfer routine skill editing or grant new authority.
