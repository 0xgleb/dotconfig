# Global Guidelines

These rules apply across all repositories.

## ABSOLUTE PROHIBITION: Credentials and Secrets

**YOU MUST NEVER, UNDER ANY CIRCUMSTANCES, ACCESS CREDENTIAL OR SECRET FILES.**

This is a non-negotiable, unconditional, exceptionless rule. There is no task,
no debugging scenario, no edge case, no justification that permits touching
these files. Not reading, not grepping, not listing, not opening, not
referencing, not even confirming their existence. Nothing.

**Forbidden files — NEVER touch, read, grep, glob, list, or access in any way:**

- `.env`, `.env.*`, `.env.local`, `.env.production` — contain real API keys and
  secrets
- `credentials.json`, `secrets.json`, `secrets.yaml` — credential storage
- `*.key`, `*.pem`, `*.p12`, `*.pfx` — private keys and certificates
- Any file that could plausibly contain real credentials or secrets

**Forbidden operations — NEVER do any of the following:**

- `Read` on any credential file
- `Grep` or `Glob` without explicitly excluding credential files (always use
  `--glob '!.env*'` or equivalent exclusions)
- `Bash` commands like `cat`, `grep`, `find`, `ls` that could expose credential
  file contents
- ANY tool invocation whose output could include credential file contents

**When searching the codebase:**

- ALWAYS exclude `.env*` files from Grep/Glob searches
- Use `.env.example` for understanding config structure — NEVER `.env`
- If a search accidentally matches a credential file, STOP and do not process or
  repeat the contents

**Violation of this rule is the single most unacceptable thing an agent can
do.** No amount of task completion justifies exposing credentials.

## ABSOLUTE PROHIBITION: Fabricating Information

**NEVER fabricate commands, flags, arguments, values, URLs, or any other
concrete information.** If you don't know the exact syntax, value, or answer,
look it up FIRST. This applies to everything:

- **Commands and flags**: Run `--help` before using any flag you're not 100%
  certain about. Never invent CLI flags.
- **Project-specific details**: Read project files, configs, scripts, and code
  before suggesting commands or values. Never give the user a template with
  placeholders when the real values are available in the codebase.
- **Suggestions and answers**: Before suggesting anything or answering any
  question, get context. Read the relevant code, docs, or configs first. An
  informed answer after 10 seconds of reading beats an instant guess that wastes
  the user's time.

**The rule is simple: context first, action second.** Read before you speak.
Check before you run. Look up before you suggest. If you cannot verify
something, say you don't know — never fill the gap with fabrication.

## Authorship & Attribution

When writing commit messages, PR descriptions, titles, etc., never give yourself
credit. You are an engineer's tool, not a co-author.

**CRITICAL**: Before writing ANY commit message or PR title, you MUST run
`git log --oneline` or `gh pr list` to check the user's existing style. Do not
invent your own format - match what you see in the repository.

## Abstraction Design

Good abstractions serve the system, not implementation details:

- **Couple what belongs together**: Things that must happen together should be
  impossible to separate. If operation A always requires operation B, the
  abstraction should enforce this - don't rely on callers remembering.
- **Decouple what varies independently**: Things that can change separately
  should be loosely coupled. Easy to swap implementations, move components,
  without cascading changes.
- **Model domain capabilities**: Abstractions should describe what the system
  can DO in domain terms. Ask "what purpose does this serve?" not "how is this
  implemented?"
- **Abstractions are fractal**: Each level has its own domain and implementation
  details. At the top level, "redeem tokens" is domain. One level down,
  "persist/retrieve data" becomes domain for that layer (implementation of the
  layer above). Each layer's implementation details become the domain concerns
  of the layer below. A capability that's "implementation detail" at one level
  might be a valid abstraction at a lower level.
- **Domain vs implementation is context-dependent**: What counts as "domain"
  depends on what the system is for. In financial infrastructure, token backing
  is domain. In a video game, the same operation might be implementation detail.
  Understand the system's value proposition to identify its domain boundaries.
- **Enable meaningful tests**: Good abstractions let you test business
  invariants, not implementation details. If tests break when refactoring
  internals, the abstraction leaked.
- **Think holistically**: Don't design for the immediate case alone. Consider
  the system as a whole - what features matter to consumers? Avoid ad-hoc
  solutions that only fit one scenario.

The mistake is focusing too narrowly on specific cases or centering on
implementation details rather than the domain.

## Roadmap Format

**Never use numbered phases** (Phase 1, Phase 2, etc.) in roadmaps. Use the
epic-based format from st0x.liquidity/ROADMAP.md:

- Each `##` section is an **epic** — a goal-oriented group of related issues
- Epics are ordered by priority (highest first) — **the first epic is always the
  next thing to implement, and whatever should be implemented next must be the
  first epic** (reorder if priorities change)
- Use mermaid dependency graphs when tasks have dependencies
- Checkbox lists (`- [ ]` / `- [x]`) with issue/PR links
- Sub-sections under epics for logical groupings
- `## Not epic` section for unorganized items
- `## Completed: <name>` sections at the bottom for done work

Epics describe WHY the work matters, not just WHAT it is. Each epic has a short
prose description of the goal before the task list.

**Maximize parallelizability.** Structure epics and tasks so independent work
streams are visually obvious. Use mermaid graphs to show what can run in
parallel vs what has sequential dependencies. Each independent work stream
becomes a git worktree with its own graphite stack, enabling multiple agents to
work simultaneously. Tasks should be large and meaningful enough to justify a
dedicated worktree — don't split into tiny pieces that create coordination
overhead.

## Code Style

- Prefer functional programming patterns
- Use strict compiler and linter settings
- Comprehensive test coverage is expected
- Model types properly - use the type system to make invalid states
  unrepresentable
- Package by feature, not by layer
- Avoid leaky abstractions
- Enforce clean domain boundaries
- Never leave useless comments. Documentation (docstrings explaining how to use
  the code) is good. Comments explaining what the code does are unacceptable
  unless something genuinely cannot be made clear through properly structured
  and named code.
- **Avoid boolean blindness**: Raw booleans obscure meaning at call sites.
  Prefer discriminated unions (e.g., `type Status = "open" | "closed"`) over
  booleans. When booleans are unavoidable, wrap them in named functions
  (`openModal()` / `closeModal()`) rather than exposing `setIsOpen(true)` /
  `setIsOpen(false)`.
- **Every change must improve something**: A change that doesn't make things
  better is worse than no change - it's overhead for reviewers. When refactoring
  to fix lints (e.g., cognitive complexity), ensure the extraction actually
  addresses the metric. Extracting trivial logging statements doesn't reduce
  control flow complexity; extracting logic with branches/loops does.
- **Module organization - public API first**: Within each module, order code so
  the most important things appear first:
  1. Public types, traits, and structs (what consumers use)
  2. Public functions and impl blocks for public types
  3. Private helper types and functions (implementation details)

  This makes diffs easier to review - the important changes show up first, with
  supporting details below. Reviewers can stop reading once they understand the
  public interface.

## Bash Usage

**No bash for loops or complex bash commands.** Use dedicated tools (Glob, Grep,
Read) for searching and reading files. Bash is for simple, single-purpose
commands like `cargo check`, `git status`, etc.

**NEVER run ad-hoc scripts** (`python3`, `node`, `ruby`, shell scripts, etc.)
for ANY purpose — not for searching, text processing, data extraction, or
anything else. Use the dedicated tools (Grep, Glob, Read, etc.). Ad-hoc scripts
trigger approval prompts that block the user and waste their time.

**When context is lost** (after compaction or session resumption): if you cannot
remember something the user told you, **admit it and ask** rather than trying
workarounds or guessing. Fabricating approaches to avoid admitting lost context
is worse than asking.

**NEVER prefix commands with environment variable overrides** (e.g.,
`GIT_EDITOR=true git rebase ...`, `DATABASE_URL=... cargo test`). These trigger
an approval prompt that blocks the workflow. If a command needs env vars, find
an alternative approach (e.g., use flags, config files, or restructure the
command).

**One command per Bash call.** Never chain unrelated commands with `&&`, `;`, or
`||`. Never add decorative separators like `echo "---"`. Each Bash tool call
requires user approval — combining multiple commands into one call forces the
user to approve/reject them as a bundle, which is disruptive and wasteful.

**Keep commands simple and inline.** Never use `$(cat <<'EOF' ... EOF)` or
similar heredoc constructs for commit messages or arguments — just pass the
string directly with `-m "message"`. Overcomplicated shell constructs trigger
manual approval prompts, block the workflow while the user isn't looking, and
look terrible in logs. If a message doesn't fit in a simple `-m "..."`, it's too
long.

**Verify after state transitions.** After any command that changes state (`cd`,
`git add`, `git checkout`, etc.), run a read-only verification command in a
separate Bash call (`pwd`, `git status`, etc.) to confirm the transition
succeeded. Never assume success — confirm it.

**Never pipe to `| tail` or `| head`** to limit command output. If you're
worried about too much output, redirect to a file instead:
`command > ./.tmp/descriptive-name` (relative path, `.tmp/` directory). Then
read the file with the Read tool if needed.

**CRITICAL: Before running `git checkout -- <file>` or any command that discards
working tree changes**, always run `git status` first to check for staged and
unstaged changes. Blindly running `git checkout` destroys work — both your edits
and anything the user may have staged.

## Communication

The user does not read all output produced while working. They review and
stage/commit changes or give feedback at the end.

If you don't know how to fulfill the request, need the user to choose between
options, or need something else from them:

- Do NOT just ask and keep going (the user won't see it)
- Do NOT decide you can violate requirements because something is hard or
  confusing (the user will be furious)
- STOP and make it clear you need input before proceeding

**Work until done:** Don't stop until all tasks are complete or you need user
input. Keep working through the task list autonomously. Never stay idle when
there are pending tasks you're not blocked on — check the task list and pick up
the next one immediately.

**Exhaust options before dismissing.** When asked to do something, seriously
consider every available tool and approach before claiming it can't or shouldn't
be done. If the first approach has issues (e.g., violates composability), think
about whether a different approach achieves the same goal without the tradeoff.
Scripts, checks, assertions, test derivations — explore all of them before
concluding "not feasible."

**Verify-and-fix workflow:** When told to "verify each finding against the
current code and only fix it if needed" (PR review feedback), follow this exact
sequence:

1. Create tasks for every finding upfront
2. Work through all valid findings and fix them — do ALL the work first
3. After ALL fixes are committed, provide a summary listing which findings were
   invalid and explain WHY each one didn't need to be addressed

Always give the invalid-findings list at the end, every time. Never skip it.
Don't interrupt the fix workflow with validity assessments — do the work first,
report at the end.

## Plan Adherence

**CRITICAL: Never unilaterally deviate from an approved plan.** When you
encounter problems with the planned approach:

1. **Either follow the plan as written**, OR
2. **Stop and present a case for changing course** - explain what you found, why
   the planned approach is problematic, and what you'd propose instead. Then
   WAIT for approval before doing anything.

You are NOT authorized to substitute tools, libraries, or approaches on your
own, even if you believe your alternative is better. The user approved a
specific plan; changing it without their consent is insubordination, not
initiative.

**User instructions override the plan.** If the user says to do something that
contradicts the plan, follow the user's instruction and update the plan to
match. The plan serves the user, not the other way around.

## Absolute Accountability for Warnings and Errors

**CRITICAL**: When any warning, error, or issue is pointed out or appears in
output:

- NEVER check if it's "pre-existing" as an excuse to avoid fixing it
- NEVER assume the issue existed before your changes
- ALWAYS fix it immediately, no questions asked
- The codebase has strict CI with zero tolerance for warnings/errors - nothing
  gets through
- If you can't remember creating the problem, it's because you lost context, NOT
  because it's someone else's fault
- Any attempt to deflect responsibility is unacceptable

## Todo List Discipline

**CRITICAL: Every user request or feedback MUST be recorded as a task before
doing anything else.** This applies whether you plan to address it immediately
or later. The task list is the single source of truth for what needs doing.

1. User says something -> record it in the task list FIRST
2. Then either work on it now or continue current work
3. Never rely on "I'll remember" - you won't after compaction

Recording can mean creating a new task, splitting a request into multiple tasks,
or updating/clarifying an existing task - whichever fits best.

The todo list is your persistent memory across compactions. Without it, user
requests get lost when context is compressed.

## Subagent Delegation

Use the task list to drive subagent delegation. When working through tasks:

- **Delegate mechanical work to background subagents**: Renames, pattern fixes,
  import reorganization, and other repetitive edits across files. Keep your
  foreground context for complex reasoning and architecture decisions.
- **Delegate tasks touching different code areas**: If your current work is in
  module A and a task touches module B, hand it to a subagent rather than
  context-switching.
- **Keep complex work in the foreground**: Anything requiring judgment,
  cross-module understanding, or iterative problem-solving stays with you.

### Subagent rules

**CRITICAL: Subagents are restricted to file reads and edits only.**

**Allowed tools:** Read, Edit, Write, Glob, Grep, WebFetch, WebSearch.

**FORBIDDEN in subagents:**

- `Bash` for ANY purpose - no `sed`, `awk`, `grep`, `find`, `cat`, shell loops,
  `curl`, or ad-hoc scripts. Use the dedicated Read/Edit/Glob/Grep tools instead
- `cargo` commands - the Cargo.lock will compete across parallel agents and
  nothing will actually parallelize. Only the orchestrating agent runs cargo
- `git` commands - subagents must NEVER run `git checkout`, `git restore`,
  `git stash`, or any git command that modifies working tree state. A subagent
  running `git checkout` on a file DESTROYS unstaged work with no recovery

**Prompt template for subagents:**

Every subagent prompt MUST include these constraints verbatim:

```
RULES:
- Use ONLY Read, Edit, Write, Glob, Grep, WebFetch, WebSearch tools. NEVER use Bash.
- Do NOT run cargo, git, sed, awk, curl, or any shell commands.
- Do NOT create scripts or temporary files.
- Make your edits and report what you changed.
```

**Scope:** Each subagent should have a narrow, well-defined task (e.g., "rename
X to Y in these 3 files"). Do not give subagents broad exploratory mandates that
could lead to unintended changes.

**Include all relevant rules in the prompt**: The user cannot chat with
subagents to steer them. Every repo-specific guideline, naming convention, code
style rule, and constraint relevant to the subagent's task MUST be included in
the prompt upfront. Copy the relevant sections verbatim from AGENTS.md or
CLAUDE.md if needed - being thorough here prevents rework.

**Never read multiple subagent outputs back-to-back.** Reading responses from
several agents in quick succession (e.g., checking on 3-5 completed agents in
one turn) will blow out the context window and trigger compaction. Instead,
check on ONE agent at a time: read its output, process/verify it, then move on
to the next agent in a subsequent turn. Space out the reads across turns.

**You own subagent output.** Like a team lead is responsible for the team's
output, you are responsible for everything subagents produce. Review all
changes, assess quality, check for guideline violations, and fix any problems
(yourself or via another subagent) before considering the task complete.

## Workflow

- **Type-driven TDD (TTDD)**: In typed languages, follow this sequence:
  1. **Types first**: Define types, traits/interfaces, and method signatures
     that model the domain
  2. **Failing tests**: Write tests that compile but fail (build errors don't
     count as failing tests)
  3. **Implementation**: Write the logic to make tests pass
  4. **Refine**: Add more tests for comprehensive coverage or refine types as
     needed

  Steps 1 and 2 can be interleaved - you may need to update types/signatures to
  make tests compile. The key constraint: **do not write implementation logic
  until you have a test that compiles and fails**. Type-level changes (struct
  fields, method signatures, trait bounds) are fine before the failing test;
  behavioral logic is not.

  For bug fixes, apply the same pattern: write a test that compiles and fails by
  asserting the correct behavior, then fix the bug to make the test pass.

  **Bug reproduction must be realistic.** When writing a failing test to
  reproduce a bug:
  - Exercise the actual code paths that failed in production
  - Use fixtures that mirror real data (same formats, schemas, edge cases)
  - Call the actual functions/methods involved, not contrived shortcuts
  - The goal is to prove the bug exists in the real system

  A test that manually constructs invalid state and shows it fails proves
  nothing - it just demonstrates that invalid things are invalid. A proper
  reproduction runs the real code on realistic inputs and shows it produces the
  wrong output.

- Don't write throwaway scripts for experimentation. Write tests instead, and
  remove them when no longer needed.

- **Commit and push as you go**: After completing each task (or logical unit of
  work), commit the changes using Graphite and push (`gt ss`) before moving to
  the next task. Don't accumulate uncommitted or unpushed work across multiple
  tasks — small, incremental commits pushed regularly make progress visible,
  reviewable, and safe from local failures. Never wait for the user to ask you
  to commit or push.

- **Branch immediately when stacking**: When told to stack changes (e.g., "put
  this on the stack", "stack a PR for this"), IMMEDIATELY create a Graphite
  branch with `gt create` before making any edits. Do not accumulate changes on
  master or an unrelated branch. After the initial commit, regularly `gt modify`
  as you make progress and `gt ss` to sync with remote. The user should never
  have to ask "why aren't we on a branch yet?"

## Diff Review (Before Handing Over)

After verification passes (tests, lints, etc.), review the diff and revert any
chunks that lack clear justification. Every line in a diff is review overhead
for the user.

**Justified changes:**

- Explicitly requested by user
- Required to make the requested change work
- Fixes a bug or warning encountered during the task
- Improves readability of code being modified
- Enforces stricter domain boundaries or reduces coupling

**Unjustified changes (revert these):**

- Renaming things not related to the task
- Reformatting code outside the change area
- "While I'm here" improvements that YOU decided to make (user-requested "while
  I'm here" changes are fine)
- Changing terminology without explicit request (e.g., "microservices" to
  "multi-node")
- Adding comments to unchanged code
- Reorganizing imports in files you didn't meaningfully change

**When context is ambiguous** (after compaction or new session): if you cannot
point to an explicit user request in the visible conversation that justifies a
change, treat it as unjustified and revert it. The user may have sanctioned
changes in compacted context, but you cannot verify that - err on the side of
reverting. The user can always re-request changes they wanted.

If you cannot articulate why a change is necessary, revert it.

## GitHub Issues

When creating issues:

- Only describe the problem - do not include suggestions or proposed solutions
- Solution decisions belong at implementation stage, not in the issue
- Reference code by file/function/struct names, not line numbers (line numbers
  go stale)

## Version Control (Graphite)

Graphite manages stacked PRs on top of git. Each branch = one PR. PRs stack on
top of each other for incremental review.

**Docs:** https://graphite.com/docs/cli-quick-start **Command reference:**
https://graphite.com/docs/command-reference

### Core commands

| Command                     | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `gt init`                   | Initialize graphite tracking in a repo                           |
| `gt create <name> -m "msg"` | Create a new stacked branch/PR from staged changes               |
| `gt modify`                 | Amend current branch commit, auto-restacks descendants           |
| `gt modify -a`              | Stage all + amend                                                |
| `gt modify --into <branch>` | Amend into a downstack branch without checking it out            |
| `gt ss`                     | Submit the entire stack to remote (force push)                   |
| `gt ss --publish`           | Submit and publish (non-draft)                                   |
| `gt co`                     | Interactive checkout                                             |
| `gt sync`                   | Sync state with remote, clean merged branches                    |
| `gt get <branch>`           | Fetch an existing graphite branch from remote                    |
| `gt restack`                | Resolve conflicts after moving PRs around                        |
| `gt reorder`                | Change the order of PRs in the stack                             |
| `gt move`                   | Move current PR on top of another                                |
| `gt absorb`                 | Distribute uncommitted changes to their respective PRs downstack |
| `gt ls`                     | Show current stack (short)                                       |
| `gt ll`                     | Show current stack (long, with commit graph)                     |

### Workflow

1. Stage files with `git add` (graphite sits on top of git)
2. `gt create <branch-name> -m "commit message"` to create a PR
3. Stack more PRs with additional `gt create` calls
4. `gt ss --publish` to push everything
5. `gt sync` to pull latest and clean up merged branches

### Rules

- **Do NOT run `gt` commands in subagents.** Only the orchestrating agent or the
  user runs graphite commands.
- Use `gt modify` to amend, NOT `git commit --amend`
- Use `gt sync` to pull, NOT `git pull`
- Read-only git commands (`git status`, `git diff`, `git log`) are fine
- When the user needs to run a graphite command, **stop and tell them the
  intent** (e.g., "we need to submit the stack"). If they don't know the
  command, then provide it.

## Git Worktrees

Use a `.worktrees/` directory (gitignored) inside the repo for parallel work
without stashing or switching branches.

```
myrepo/              # regular clone, main working tree on your current branch
  .worktrees/        # gitignored, spin up as needed
    feat/auth/       # worktree for auth feature
    feat/billing/    # worktree for billing feature
```

**Setup:** Add `.worktrees/` to `.gitignore`, then create worktrees with:

```bash
git worktree add .worktrees/feat/my-feature -b feat/my-feature
```

**Cleanup:** Remove when done:

```bash
git worktree remove .worktrees/feat/my-feature
```

**Key points:**

- No bare clone ceremony — works with a normal clone
- Each worktree gets its own working directory and branch
- Shared `.git` object store — no extra disk for history
- `.worktrees/` is gitignored so worktree state is local-only

**Submodules in worktrees:** Git worktrees don't share submodule checkouts. If a
project has submodules (e.g., `lib/`), the worktree will have broken gitlinks.
Fix by creating a **real directory** with individual symlinks inside (Git 2.45+
rejects symlinks in intermediate path components per CVE-2024-32002):

```bash
# From the worktree root (e.g., .worktrees/category/name/)
mkdir lib
ln -s ../../../../lib/forge-std lib/forge-std
ln -s ../../../../lib/other-sub lib/other-sub
# Adjust ../ depth to match worktree nesting: one ../ per directory level
# to reach the main repo root, then append lib/<submodule>

# Hide the "deleted" submodule gitlinks from git status
git update-index --assume-unchanged lib/forge-std lib/other-sub ...
```

The individual symlinks make builds work while keeping `lib/` a real directory
(satisfying git's security checks); `--assume-unchanged` keeps `git status`
clean. The `gt modify -a` flag won't work (it runs `git add --all` which fails
on broken submodule refs) — always stage specific files with `git add <files>`
then `gt modify`.

## This Repository (dotconfig)

### Build Commands

```bash
# Build and apply system configuration
darwin-rebuild switch --flake ~/.config

# Build without applying
darwin-rebuild build --flake ~/.config

# Format Nix files
nixfmt *.nix
```

### Architecture

Nix flake managing two targets from a single repo:

- **darwwwin** — macOS workstation (aarch64-darwin) via nix-darwin
- **nixxxos** — NixOS server on DigitalOcean (x86_64-linux)

| File               | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `flake.nix`        | Flake definition, system configs, helper scripts             |
| `common.nix`       | Shared packages and settings (both platforms)                |
| `darwin.nix`       | macOS-specific: homebrew, GUI apps, hostname                 |
| `nixos.nix`        | NixOS-specific: SSH, firewall, users                         |
| `digitalocean.nix` | Disk/boot config for DO droplets                             |
| `home.nix`         | Home Manager: zsh, git, doom-emacs, zellij, fzf, direnv      |
| `doom/`            | Doom Emacs config (managed by nix-doom-emacs-unstraightened) |
| `zellij/`          | Terminal multiplexer config                                  |
| `karabiner/`       | Keyboard remapping (caps lock → ctrl/esc)                    |

### Neovim (AstroNvim v5)

Mason is disabled. LSP servers are provided via Nix and managed through standard
lspconfig:

- **Binaries**: Added to `programs.neovim.extraPackages` in `home.nix`
- **Registration**: Listed by lspconfig name in `astrolsp opts.servers`
  (`nvim/lua/plugins/astrolsp.lua`)
- **Both steps required**: A binary without registration won't start; a
  registration without a binary will error

Home Manager owns neovim — do NOT add `neovim` to `common.nix` or `darwin.nix`.
The HM wrapper ensures `extraPackages` are on nvim's PATH.

**Do NOT use rustaceanvim.** It manages rust-analyzer outside the standard
lspconfig flow, which breaks goto-definition and all semantic LSP actions.
rust-analyzer runs through standard lspconfig like every other server.

### Doom Emacs

Managed declaratively via nix-doom-emacs-unstraightened. No `doom sync` — edit
`doom/` files and `darwin-rebuild switch`.

### Adding Packages

- Shared (both platforms): `common.nix`
- macOS only: `darwin.nix`
- NixOS only: `nixos.nix`

## Notes Vault Organization

The unified notes vault at `~/code/st0x/notes/` is automatically synced from
multiple source repositories via the `syncNotes` launchd service. This allows
Obsidian to index all markdown files in one fast vault instead of scanning
multiple directories.

### Organizational Rules

**Directory Structure by Source:**

- `~/code/st0x/st0x.liquidity/` → `notes/liquidity/`
- `~/code/st0x/st0x.issuance/` → `notes/issuance/`
- `~/code/st0x/st0x.REPO/.worktrees/feat/name/` → `notes/name/` (repo name
  appended to files)
- `~/.config/` → `notes/dotconfig/`

**Naming Conventions:**

- Main repos preserve directory structure: `docs/file.md` → `docs/file.md`
- Worktree files include repo in filename: `docs/file.md` →
  `docs/file.liquidity.md`
- Paths starting with `.` are converted: `.config` → `dotconfig`

**Example Structure:**

```
notes/
  liquidity/
    ROADMAP.md
    docs/
      cqrs.md
      architecture.md
  issuance/
    ROADMAP.md
  feat-branch/
    docs/
      design.liquidity.md
  dotconfig/
    CLAUDE.md
    home.nix.md
```

**Sync Behavior:**

- Bidirectional: repos ↔ notes
- Only syncs files with parity in source repositories
- Files in notes without corresponding source files are never modified
- Allows editing in Obsidian and syncing changes back to source repos
- Automatically triggered on file changes (via fswatch)

**Service Details:**

- Runs continuously via `launchd.user.agents.syncNotes`
- Logs to `/tmp/sync-notes.out` (debug with `tail -f`)
- Rebuilds applied with `darwin-rebuild switch --flake ~/.config`
