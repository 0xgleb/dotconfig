# Global Guidelines

These rules apply across all repositories.

## ABSOLUTE PROHIBITION: Credentials and Secrets

**YOU MUST NEVER, UNDER ANY CIRCUMSTANCES, ACCESS CREDENTIAL OR SECRET FILES.**
No task, debugging scenario, or edge case permits it — not reading, grepping,
listing, opening, referencing, or even confirming their existence.

**Forbidden files** (never touch, read, grep, glob, list, or access in any way):
`.env`, `.env.*`, `.env.local`, `.env.production`; `credentials.json`,
`secrets.json`, `secrets.yaml`; `*.key`, `*.pem`, `*.p12`, `*.pfx`; any file
that could plausibly contain real credentials or secrets.

**Forbidden operations:** `Read` on any credential file; `Grep`/`Glob` without
excluding credential files (always use `--glob '!.env*'` or equivalent); `Bash`
commands like `cat`/`grep`/`find`/`ls` that could expose their contents; ANY
tool invocation whose output could include credential file contents.

**When searching the codebase:** always exclude `.env*` from Grep/Glob; use
`.env.example` to understand config structure, NEVER `.env`; if a search
accidentally matches a credential file, STOP and do not process or repeat the
contents.

**Violation of this rule is the single most unacceptable thing an agent can
do.** No amount of task completion justifies exposing credentials.

## ABSOLUTE PROHIBITION: Fabricating Information

**NEVER fabricate commands, flags, arguments, values, URLs, or any other
concrete information.** If you don't know the exact syntax, value, or answer,
look it up FIRST:

- **Commands and flags**: Run `--help` before using any flag you're not 100%
  certain about. Never invent CLI flags.
- **Project-specific details**: Read project files, configs, scripts, and code
  before suggesting commands or values. Never hand the user a placeholder
  template when the real values are in the codebase.
- **Suggestions and answers**: Get context before answering — read the relevant
  code, docs, or configs first. An informed answer beats an instant guess.

**Context first, action second.** Read before you speak, check before you run,
look up before you suggest. If you cannot verify something, say you don't know —
never fill the gap with fabrication.

## Authorship & Attribution

When writing commit messages, PR descriptions, titles, etc., never give yourself
credit. You are an engineer's tool, not a co-author.

**CRITICAL**: Before writing ANY commit message or PR title, you MUST run
`git log --oneline` or `gh pr list` to check the user's existing style. Match
what you see in the repository — do not invent your own format.

**CRITICAL: NEVER speak on the user's behalf via any account or channel you can
authenticate as them.** Their `gh`, `linear`, `slack`, telegram, gmail, etc.
tokens are theirs — anything you publish through them lands under their name.

Without an explicit in-session instruction to post that exact content, **never**:

- Reply to PR review comments (`gh api .../pulls/comments/<id>/replies`, `gh pr
  review --comment`, `gh pr comment`).
- Comment on issues (`gh issue comment`, Linear `linear issue comment`, etc.).
- Send messages on chat platforms (Slack, telegram, Discord, etc.).
- Post on social or public threads under their identity.
- React, resolve, or otherwise emit any user-visible signal downstream readers
  will read as the user's voice.
- **Submit a review verdict — approve, comment-as-review, or request changes —
  or request, re-request, or remove a PR's reviewers.** The review verdict is the
  user's alone: only the user reviews, and only the user decides when and what
  gets submitted — they submit it themselves in the UI. Re-requesting pings a real
  human and resets approval state under the user's name. NEVER run a review
  submission (`gh pr review --approve` / `--comment` / `--request-changes`, or any
  reviews-API call carrying an `event`) and never touch reviewer state. This is
  about review-API calls, NOT pushing code — a `gt ss`/stack submit does not touch
  review state.

  **Drafting a review is the allowed assist; submitting it is never yours.** You
  may help the user review — draft the findings and (when that's the task) post
  them as a PENDING, unsubmitted review: inline draft comments that stay private
  to the user until they submit. The user then takes another pass in the UI,
  decides what to add/remove/keep/adjust, and chooses whether to approve, comment,
  or request changes (with or without comments). You only ever produce the draft;
  the verdict and the submit are theirs. Never phrase your output, a commit, or a
  note as if YOU reviewed / approved / requested changes — those are the user's
  actions.

If you disagree with PR feedback, an issue/chat comment, or any other input,
**surface it to the user and let them decide whether and how to respond.** Hold
your assessment as an opinion you bring to them, not something you post outward.

Exceptions are scoped, mechanical surfaces where impersonation isn't the risk
(opening/editing PRs you were told to open, creating/editing Linear issues you
were told to create, committing code you wrote). Even there, default to "act
under instruction", not "decide for them". Violating this rule means the user
has to apologise for words they didn't say.

## Publishing

Push policy is repo-specific: branch protection rules, contributor count,
and stack workflow all shape what's safe. See the repo's own `AGENTS.md`
for the policy that applies. Two cross-repo invariants stay regardless:

- **Respect branch protection.** If a repo protects a branch (e.g. master
  or main) and your authenticated user has admin rights that could
  override the protection, NEVER push to that protected branch without
  an explicit per-session instruction to do that exact thing. Admin
  override is the only way to do harm here; do not exercise it
  unprompted.
- **No new PRs, no state flips, no comments without instruction.** Push
  policy covers `git push` / `gt ss` / `gt submit` on feature branches,
  not `gh pr create`, `gh pr ready`, `gh pr merge`, draft-to-ready
  flips, or PR/issue comments. Those still require an explicit
  per-session instruction (and PR/issue comments fall under the
  "Authorship & Attribution" speaking-via-accounts rule).

## PR Assignment

**Always assign newly opened PRs to the user (self).** `gh pr create` and
`gt submit` do NOT auto-assign; empty assignees means the PR won't show up on
the user's "my PRs" boards and they have to find it manually. After creating or
submitting any PR, run `gh pr edit <PR_NUMBER> --add-assignee @me` (assign each
PR in a `gt submit` stack).

**This is the opposite of the Linear-issue rule:** Linear issues default to
unassigned unless you're actively working on them (someone else may pick them
up); PRs default to assigned-to-self because if you opened it, you're driving it
through review.

## Execution Discipline

- If the user already told you what to do and the path is clear, start doing it
  immediately. Do not restate the request as a confirmation step.
- If you know you caused a problem and know how to fix it, fix it immediately
  instead of asking whether you should.
- Before changing code, read the relevant docs and source, develop an initial
  approach, criticize it, and refine it until the plan fits the surrounding
  architecture.
- Keep a granular task list for the current request and remove completed items
  so the remaining work is always obvious.
- Never stop while assigned work remains executable. If a goal is active,
  continue until it is achieved. If any todo is pending, continue working through
  the task list. Stop only when all assigned work is complete or all remaining
  todos are explicitly blocked with reasons.
- Treat a manual user interrupt or double-cancel as an explicit pause. Do not
  automatically resume goals, loops, or pending tasks until the user submits
  their next prompt; give them time to finish redirecting the work.
- Check free disk space before every expensive build, test sweep, or workflow.
  Stop before consuming the crash reserve; do not wait for a build to fail or Pi
  to crash.
- Track and clean agent-created artifacts after verification, including newly
  created Nix result symlinks and stale Pi temporary logs. Never delete
  pre-existing project outputs, user files, global caches, Nix generations, or
  run global garbage collection without explicit user authorization.
- Never inject keystrokes or text into the user's active Zellij pane or editor;
  it can overwrite an in-progress prompt. Use registered tools such as
  `reload_pi` instead, and keep Zellij automation confined to isolated workers.
- Never let an agent-created Zellij tab or pane steal focus from the user's
  active pane. Use only a verified unfocused launch path; if none is available,
  keep the work in a classified background workflow instead of launching it.
- Keep changes minimal and reviewable. Prefer improving the relevant
  documentation in-repo when a lesson should help future work in the same
  repository.
- Use `@path/to/file.md` syntax when pointing to repository files in prose meant
  for Claude-compatible tooling.
- When a significant architectural decision is not already answered by existing
  docs, write an ADR at `adrs/$INDEX-$PROPOSAL_NAME.md`, summarize it briefly
  for the user, and stop for review before proceeding with that direction. Once
  approved, follow the ADR without re-asking the same question.

## Abstraction Design

Good abstractions serve the system, not implementation details:

- **Couple what belongs together**: If operation A always requires operation B,
  the abstraction should make them impossible to separate — don't rely on
  callers remembering.
- **Decouple what varies independently**: Things that change separately should
  be loosely coupled — easy to swap implementations without cascading changes.
- **Model domain capabilities**: Abstractions describe what the system can DO in
  domain terms. Ask "what purpose does this serve?" not "how is this
  implemented?"
- **Abstractions are fractal**: Each level has its own domain and implementation
  details. "Redeem tokens" is domain at the top; one level down
  "persist/retrieve data" becomes that layer's domain. A capability that's
  implementation detail at one level may be a valid abstraction below it.
- **Domain vs implementation is context-dependent**: What counts as "domain"
  depends on what the system is for. In financial infrastructure token backing
  is domain; in a video game the same operation might be implementation detail.
- **Enable meaningful tests**: Good abstractions let you test business
  invariants, not internals. If tests break when refactoring internals, the
  abstraction leaked.
- **Think holistically**: Consider the system as a whole — what features matter
  to consumers? Avoid ad-hoc solutions that only fit one scenario.

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
- In TypeScript and JavaScript, prefer `const`-bound arrow functions over
  `function` declarations. Use an explicit callable type when it clarifies the
  public contract; reserve declarations for overloads, generators, or APIs that
  specifically require declaration semantics.
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

**Bash loops are fine.** (The old ban predated auto mode: compound commands
used to hang on manual approval even when each iteration was pre-approved. The
auto classifier handles them now.) Still use dedicated tools (Glob, Grep, Read)
for searching and reading files rather than shell pipelines.

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

**EXCEPTION — builds, tests, CI, and long-running tools: show ALL output
live.** For `cargo check`/`build`/`test`/`nextest`/`clippy`, `nix build`,
`nix run .#ci`, `bun run check`/`test`, `forge test`, `npm test`, deploys,
migrations, etc.: run the command bare — no `> file`, `| tail`, `| head`,
`| grep`, or `2>&1 > ...`. Let stdout/stderr stream to the terminal and parse
the tool result yourself afterward; never run a second command to slice the log.
This holds regardless of output size — the user wants to see progress live.

The redirect-to-`.tmp/` pattern is reserved for output you genuinely don't need
live (e.g. a one-off grep over a large corpus, a JSON dump you'll later jq).

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

### Granularity: more is better, not less

The task list is **downstream of the issue / spec, not a substitute for it**.
For each Linear issue (or equivalent) you are actively working on, break it
down into the concrete implementation steps it will take -- the failing test,
the type-level changes, the implementation, the cleanup pass, the description
update, the assignment. Each of those is a task.

"One issue at a time" is a **work-focus** rule, not a task-list-pruning rule.
It means: don't context-switch across issues mid-flight, finish what you
started before starting the next. It does **not** mean: keep the task list
sparse, collapse multi-step work into one line, or delete entries to look
focused. The opposite -- if the issue requires five concrete steps, the task
list should show five concrete tasks under it.

When the user redirects to a new issue, **do not delete the planning for the
issues you are not working on yet** -- keep their tasks in `pending` or move
them to a `[parked]`-style metadata flag, but the granular breakdown stays so
it is ready to pick up when the active issue is done.

## Session Handover Protocol

Use the `/handover` skill as the standard cooperation boundary between long,
compacted, usage-limited, or parallel human-agent sessions.

### Outgoing sessions

- Invoke `/handover` proactively when the user asks to transfer work, another
  session is expected to continue it, or context/usage limits threaten reliable
  continuation. Do not leave transfer state only in conversational memory.
- Produce the skill's workspace-level handover document and continuation prompt
  from verified repository state. Never stage or commit the temporary artifact.
- A handover transfers responsibility; it does not mark unfinished todos done.
  Preserve every pending request, blocker, decision, and exact pause point.

### Receiving sessions

- When the user says a handover exists, or a continuation prompt names one,
  read that handover before resuming implementation. Treat its user requests as
  still-active intent unless the current user message cancels or supersedes them.
- Record **every** transferred request, feedback item, blocker, and concrete next
  step in the branch-aware todo list before doing further work. Deduplicate
  equivalent existing tasks, but never silently drop or collapse requirements.
- Reconcile the handover against current Git state and current project
  instructions before editing; handovers can become stale and never override
  higher-priority or newer user direction.
- Briefly surface what was imported into the task list so the human can see that
  the transfer succeeded, then continue autonomously from the named pause point.

### Continuity rules

- If another session is told to run `/handover`, the receiving session owns
  discovering, ingesting, tracking, and completing that transferred work.
- After compaction or resume, use the todo list plus any active handover as the
  continuity source. Ask the user only when those artifacts and repository state
  genuinely cannot resolve an ambiguity.
- Never copy secrets into handovers or todos; name the relevant configuration
  key or protected location instead.

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
X to Y in these 3 files"), never a broad exploratory mandate that could lead to
unintended changes.

**Include all relevant rules in the prompt**: The user cannot chat with
subagents to steer them. Every repo-specific guideline, naming convention, code
style rule, and constraint relevant to the task MUST be in the prompt upfront —
copy the relevant sections verbatim from AGENTS.md if needed.

**Never read multiple subagent outputs back-to-back.** Reading several agents'
responses in one turn blows out the context window and triggers compaction.
Check ONE agent at a time: read, process/verify, then move to the next in a
subsequent turn.

**You own subagent output.** Like a team lead, you are responsible for
everything subagents produce. Review all changes, check for guideline
violations, and fix any problems before considering the task complete.

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
  work), commit the changes and push before moving to the next task. Don't
  accumulate uncommitted or unpushed work across multiple tasks — small,
  incremental commits pushed regularly make progress visible, reviewable, and
  safe from local failures. Never wait for the user to ask you to commit or
  push. Use plain `git commit` + `git push` by default; only use Graphite (`gt
  modify` / `gt ss`) in repos that have explicitly opted in (see "Version
  Control" below).

- **Branch immediately when stacking**: When told to stack changes (e.g., "put
  this on the stack", "stack a PR for this"), IMMEDIATELY create a branch
  before making any edits. Do not accumulate changes on master or an unrelated
  branch. Use `git checkout -b` by default; use `gt create` only in
  Graphite-opted-in repos. The user should never have to ask "why aren't we
  on a branch yet?"

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

## PR Descriptions

**Always follow the repo's PR template** (commonly
`.github/PULL_REQUEST_TEMPLATE.md`). Read it once per repo and match
its section headings exactly. The default shape, used whenever a repo
does not ship its own template, is **Motivation / Solution** — never
What/Why/How:

```
## Motivation

<!-- Why is this change needed? Link the issue/ADR it advances. State the problem
     and the desired end state, not the diff. -->

## Solution

<!-- How does this PR solve it? Approach and key design decisions. One line per
     bullet; detail belongs in the code or the linked issue. Note stack
     relationships and any trade-offs or follow-ups. -->
```

**Don't journal.** A PR description is not your work narrative.

- No "Finishing in-progress work" / "First half of the refactor" /
  "After CodeRabbit feedback" framings — those are commit-history
  concerns, not reviewer concerns.
- No sections that document YOUR process. Reviewers care about
  intent, behavior change, and risk.
- Drop sections that have no content for this PR (e.g. no
  `## Screenshots` section if there's nothing to screenshot).
- One liner per bullet. Detail belongs in the code, the linked
  issue, or the commit message — not as a paragraph in the PR body.

## Nix CLI Flag Placement

**Top-level nix flags go BEFORE the subcommand, not after.**

```
# Right
nix --accept-flake-config develop .#shell -c <cmd>
nix --accept-flake-config run .#package
nix --accept-flake-config fmt -- file.nix
nix --accept-flake-config build .#package

# Wrong (the flag is silently ignored or interpreted as a subcommand arg)
nix develop --accept-flake-config .#shell -c <cmd>
nix run --accept-flake-config .#package
```

Top-level flags include `--accept-flake-config`, `--impure`,
`--show-trace`, `--allow-import-from-derivation`,
`--experimental-features`, etc. Subcommand-specific flags (e.g.
`--profile` for `nix-env`, `-c` for `nix develop`) go after the
subcommand. If unsure, check `nix --help` (top-level flags) vs
`nix <subcommand> --help` (subcommand flags).

## Keeping Issues and PRs Fresh

**CRITICAL: Issue and PR descriptions must stay in sync with reality.** This
applies to every issue and every PR, in every tracker (Linear, GitHub, etc.),
on every repository — not just the one currently in focus.

- When the **scope of work changes** (a reviewer comment gets folded in,
  rebase brings in new code that needs treatment, a related sub-task surfaces
  that the PR now handles), update the issue and PR descriptions *before*
  resubmitting / closing — never leave a stale "What" or "How" section
  describing the diff from three iterations ago.
- When a **decision is made or reversed** during implementation that changes
  the rationale, update the "Why" section so future readers see the
  rationale that actually applies to the merged code, not the one the PR
  was opened with.
- When **dependencies, milestones, or cross-links change** (new linked
  issue, new milestone attached, sub-issue absorbed), update the metadata
  *and* the description so the prose matches the structure.
- When something **moves out of scope and into another issue**, say so
  explicitly in the original issue/PR so reviewers don't waste time
  hunting for it.

The default is: any time you push new work to a PR or change what an issue
is about, the description gets re-read and updated if it no longer matches.
Stale descriptions waste reviewer time and create false records of what
shipped.

## Version Control

**Default to plain `git`.** Use `git checkout -b`, `git commit`, `git push`,
`git pull`, `git rebase` — the standard tools. Do not invoke `gt` unless the
repo has explicitly opted into Graphite.

**A repo is opted into Graphite only if** at least one of the following is
true:
- A `.graphite_repo_config` file exists at the repo root.
- A repo-level CLAUDE.md or AGENTS.md tells you to use Graphite for that repo.
- The user has told you (in this session or via memory) to use Graphite here.

If none of those hold, treat the repo as plain-git and never run `gt init`,
`gt create`, `gt modify`, `gt ss`, etc. — including not running them
"speculatively" to check state. `gt ls` will silently initialize Graphite if
not present, so do not use it as a probe; check for `.graphite_repo_config`
instead.

### Graphite (only in opted-in repos)

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
- **A stack submit (`gt ss`) is review-state-neutral.** It force-pushes commits
  like any push and does NOT re-request reviewers or dismiss approvals on its own
  — approval dismissal is a GitHub branch-protection setting ("dismiss stale
  approvals on push"), tool-agnostic, and only affects PRs targeting a protected
  branch. The reason to scope a submit is noise, not review state: `gt ss`
  submits the WHOLE stack, so when you changed one branch, push just that branch
  (or run `gt submit --dry-run` first to see No-op vs Update) instead of
  re-pushing branches you didn't touch.
- When the user needs to run a graphite command, **stop and tell them the
  intent** (e.g., "we need to submit the stack"). If they don't know the
  command, then provide it.

## Git Worktrees

Use a `.worktrees/` directory (gitignored) inside the repo for parallel work
without stashing or switching branches. Each worktree gets its own working
directory and branch, sharing the `.git` object store (no extra disk for
history); `.worktrees/` is gitignored so worktree state is local-only.

**Setup:** Add `.worktrees/` to `.gitignore`, then
`git worktree add .worktrees/feat/my-feature -b feat/my-feature`.

**Cleanup:** `git worktree remove .worktrees/feat/my-feature`.

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

**Sync Behavior:** bidirectional (repos ↔ notes), only syncs files with parity
in source repos, never modifies notes files without a corresponding source
file, allows editing in Obsidian and syncing back, triggered on file changes
(via fswatch).

**Service Details:** runs continuously via `launchd.user.agents.syncNotes`,
logs to `/tmp/sync-notes.out` (debug with `tail -f`), rebuilds applied with
`darwin-rebuild switch --flake ~/.config`.

## Personal Skills

Shared skills live in `~/.config/ai/skills/` and are symlinked into both harnesses:

- Claude: `~/.claude/skills` → `~/.config/ai/skills`
- Cursor: `~/.cursor/skills` → `~/.config/ai/skills`

- Linear is the work tracker for the **st0x** and **rainlanguage** repos
  (`~/code/st0x/*`, `~/code/rainlanguage/*`) — the same orgs that use Graphite.
  Other repos do **not** use Linear: this dotconfig repo, and any repo outside
  those orgs, track work in GitHub issues (or nowhere). Don't reach for Linear,
  defer review findings to Linear, or assume issues live there unless you're in
  a Linear-tracked repo.
- For Linear work (in those repos), use
  `/Users/0xgleb/.config/ai/skills/linear/SKILL.md`. Default to read-only
  operations first, inspect `linear --help` before using unfamiliar commands,
  and treat `linear api` mutations as high-risk until the exact payload has been
  reviewed.
