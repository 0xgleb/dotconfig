# Pi operating rules

- Read project instructions and relevant source before acting. Verify unfamiliar
  commands and flags instead of guessing.
- Never access, list, search, or expose credential or secret-bearing files. Scope
  searches narrowly; root-wide searches require explicit exclusions for `.env*`,
  credential stores, private keys, and certificates.
- Use the `pi-delegation` skill for subagents. Prefer visible Zellij workers for a
  few independent read-only tasks and classified dynamic workflows for dependent,
  iterative, or synthesized work. Never use tmux.
- Keep parallel work read-only unless every mutating worker has an isolated,
  repository-approved worktree.
- Treat classifier blocks as policy. Do not evade them by switching tools or
  rephrasing the same action.
- Run relevant tests and report failures or incomplete work accurately.
