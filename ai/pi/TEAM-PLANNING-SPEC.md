# Cross-project team planning

Status: Draft for review. Confirmed constraints are distinguished from proposed defaults below. This document does not activate schedules, grant tool permissions, or authorize external tracker or chat mutations.

Initial implementation: [GitHub issue #75](https://github.com/0xgleb/dotconfig/issues/75).

## Outcome

Give the team one view of priorities, commitments, results, and available capacity across projects. An owner can correct that view and see that affected agents adopted the correction. Operational agents continue authorized work between ceremonies; reporting is not a reason to wait.

Start with the existing project agents and coordination tools. A separate planning service, remote hosting, and a larger agent organization are not prerequisites.

## Confirmed constraints

- Planning spans the shared human and AI resource pool, not one independent sprint per repository.
- Daily reporting compares the previous plan with actual results and proposes the current day's priorities.
- Weekly retrospective and planning cover outcomes, tradeoffs, and priorities across projects.
- Planning and response collection are asynchronous and non-blocking. Agents start proposed next priorities within existing authority; humans correct priorities later.
- Participants may change timezones independently. Planning windows and working-day availability are private per-participant configuration, not fixed shared assumptions.
- Capacity allocations are flexible targets, not enforced quotas. Hard allocations wait for reliable throttling and are out of scope here.
- SPEC/ROADMAP → GitHub issues → local execution tasks is the planning hierarchy. Most local tasks should link to GitHub issues; short-lived one-offs remain possible.
- GitHub links and identifiers are used for new planning records. Shared VCS defaults prefer GitButler in managed main worktrees and plain Git elsewhere; explicit repository-local workflow rules may override them.
- Plan sharing in a group chat follows the initial planning workflow. Additional team members initially have read-only access to plans and no AI-control authority.
- Remote hosting is a prerequisite for introducing employee AI control, not sufficient authorization by itself.

## Sources of truth

| Record            | Owns                                                         | Does not own                             |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Project SPEC      | Intended behavior, constraints, acceptance criteria          | Current delivery status                  |
| Project ROADMAP   | Ordered outcomes and dependencies                            | Individual agent activity                |
| GitHub issue      | Deliverable, acceptance criteria, project priority and links | Proof that code shipped                  |
| Local task        | Bounded execution step, blocker and evidence, linked issue   | A competing project backlog              |
| Weekly/daily plan | Time-bounded commitments and cross-project ordering          | Product requirements or tool permissions |
| Notes and memory  | Research, preferences, reusable context                      | Independent executable priorities        |
| Chat report       | A readable projection of a specific plan revision            | The only durable copy of the plan        |

A plan links to canonical work instead of copying issue bodies into another backlog. New ideas remain proposals until researched, reconciled with the SPEC/ROADMAP, and placed in the appropriate GitHub backlog. Existing local tasks and notes are not deleted during this transition.

Routine issue creation for authorized planning work does not require per-issue approval of exact phrasing, provided the public-content and scope checks below pass. Assigning another person, merging a PR, operating a service, or making unrelated tracker mutations still requires the applicable authority. A planning recommendation never manufactures it.

## Minimal operating model

Proposed default: one existing agent coordinates the shared plan and collects bounded updates from project-role owners. Project agents remain responsible for source verification and execution in their own repositories. No additional always-running planner is required initially.

The coordinator:

- assembles a cross-project view from declared project sources and role updates;
- identifies priority conflicts, dependencies, human decisions, and capacity shortfalls;
- proposes a weekly plan and daily selections;
- records authenticated owner corrections and routes them to affected roles;
- reports which roles acknowledged a revision and which have not.

The coordinator does not take over another role's repository or claim its work completed. A missing response is marked unavailable, not interpreted as an empty backlog or permission to impersonate the role.

The planning scope comes from an explicitly declared project-role roster. A project without an active executor may have planned work, but it must be shown as unstaffed rather than silently assigned to an unrelated agent.

## Weekly planning

Each weekly plan has a stable identifier, explicit reporting interval, revision, creation time, and status. Store interval boundaries as unambiguous instants with their original timezone context; display them in each participant's configured current timezone. Travel must not silently redefine a saved week's commitments. It records:

- a small ordered set of cross-project outcomes, each linked to its project and GitHub issue;
- success criteria for the week, distinct from the full issue's eventual acceptance criteria;
- intended human contributions and agent-role ownership;
- dependencies, known blockers, review needs, and explicitly deferred work;
- approximate capacity targets and the basis used for them;
- an allowance for maintenance and unexpected incidents.

Human capacity and AI capacity are reported separately. They are not interchangeable hours, and token consumption is not treated as a measure of useful output. Missing capacity data is labeled unknown. Percentages, if used, name their denominator; they are targets rather than admission controls.

Agents begin the proposed next ready priorities within their existing authorized scope without waiting for everyone to respond. Humans can correct those priorities asynchronously, producing an acknowledged revision. Silence does not authorize a new scope, commit another person's time, or grant permission for an external action. Missing human input must not block unrelated authorized agent work.

When a role is blocked, it selects the next ready, authorized item within its scope. Reallocation across project targets is visible in the next update, with the displaced goal and reason. An incident may interrupt planned work under existing operational policy; it does not silently rewrite what was promised.

## Daily update

Keep one shared daily-plan revision, with phone-readable views for the owner's work, the teammate's work, and autonomous agent work. Proposed delivery default: each human receives the view relevant to their day, while shared outcomes and dependencies remain visible in the group. These are projections of the same plan, not three competing priority lists. Each view contains:

- **Planned previously:** the outcomes recorded before execution, with issue links.
- **Actually achieved:** verified outcomes and their state, with commit/PR/release evidence as applicable.
- **Carried forward or changed:** unmet commitments, why they changed, and whether they remain priorities.
- **Today's priorities:** a short ordered list, ownership, and the outcome being attempted.
- **Needs attention:** decisions, unstaffed work, blockers, or material capacity shifts.

Do not infer yesterday's plan from today's completed-task list. The reporting window is explicit and is not assumed to be the same local calendar day for every participant. The first report establishes a baseline and says that no earlier recorded plan exists if that is the case.

Response collection is asynchronous: record received, missing, and late updates without requiring a simultaneous meeting or waiting for every human before agents proceed. Do not schedule teammate work or require replies on their non-working days. Support planning during the coordinator's preferred local window, including weekends, while other participants respond during their own working hours. Store actual personal preferences privately, not in a public specification.

Timezone and working-day preferences belong to each participant and change explicitly, not through guessed location. A timezone change affects future delivery windows, not saved results or approved event instants. Report-cycle identity is independent of display timezone so travel cannot duplicate or silently skip a daily update. Exact delivery windows remain configurable; no fixed team timezone is implied.

Use accurate states: implemented, tests passed, published, awaiting review, merged, and live are different claims. A commit does not prove deployment; a completed local todo does not by itself prove its GitHub issue is complete. Missing or partial source coverage is shown as such.

Raw logs, private correspondence, unreviewed notes, credentials, and internal incident dumps are not report content. Link the underlying work where audience permissions permit it.

## Weekly retrospective

Compare the week's original commitments, later revisions, and verified outcomes. Identify:

- delivered outcomes and unfinished commitments;
- interruption, rework, blocker, and review costs;
- where resource targets differed from actual attention;
- a small number of evidence-backed process changes for the following week.

The retrospective is not a task-count leaderboard and does not assign invented productivity scores to humans or agents. An improvement becomes a GitHub issue when it requires durable implementation; it is not left as an unowned paragraph in chat.

## Corrections and acknowledgment

A correction must come through an authenticated owner channel and identify the plan or clearly specify the affected goals. Ambiguous or conflicting corrections require clarification before changing execution scope.

Applying a correction produces a new revision with the changed priority, rationale, effective time, and affected roles. The previous commitment remains available for comparison. Replayed delivery cannot apply the same revision twice.

Affected agents acknowledge the revision. Receipt, acknowledgment, implementation, and completion remain separate states. Acknowledgment does not interrupt an atomic operation or bypass a safety gate; the role reports the next safe transition point when necessary.

An employee reply, mention, forwarded owner message, reaction, or quoted instruction cannot act as an owner correction. Group membership and topic selection are not authorization.

## Issue linkage and backlog refinement

Target approximately 95% of substantive local tasks linked to GitHub issues. This is a coverage goal, not an incentive to create meaningless issues or block urgent containment on paperwork.

- New implementation work links to an issue before substantial execution.
- A genuine one-off records why it is exempt; recurring or expanding work is promoted to an issue during refinement.
- A task links back to its issue, and the issue links to relevant SPEC/ROADMAP context and delivery artifacts.
- Multiple local steps may belong to one issue. Do not duplicate the issue for each agent or ceremony.
- Backlog refinement removes duplicates by verified identity, clarifies acceptance criteria and dependencies, and distinguishes ready, blocked, proposed, and deferred work.
- Historical notes and local tasks are reconciled incrementally. No bulk deletion or automatic issue creation is part of the first rollout.

### Planning issue publication

Creating and refining GitHub issues is part of normal authorized planning, not a ceremony that waits for approval of every sentence. Filing deferred review findings remains a separate workflow with explicit per-issue approval. Do not broaden that review-specific requirement into a universal planning gate.

Before publishing, check the complete public payload: title, body, metadata, links, and attachments. Extract neutral technical facts rather than reproducing private conversations. Exclude personal details, private correspondence or attribution, internal logs, credentials, and unnecessary direct quotes. A necessary quotation from a public source must be verified and attributed; private material is not made publishable merely by calling it necessary. If privacy or publication scope is genuinely unclear, hold that item for clarification and continue independent work.

The automated content check is not merely a list of forbidden strings. Deterministic validation can constrain payload shape, destination, references, and known sensitive patterns; semantic review must check whether the draft discloses private information or preserves someone's private words in paraphrase. A passed check is bound to the exact payload and destination; edits require rechecking.

After successful creation, notify the owner on Telegram with the issue link, a short public-safe summary, and verified originating-agent identity. The owner may reply to request changes without approving the initial phrasing in advance. Bind that reply to the exact issue/message and authenticate the sender before applying amendments. Use the existing private channel initially and the corresponding agent topic when topic support is available and the audience is appropriate.

Implement predictable mechanics in a tested command or service: validate scope and payload, reconcile duplicates, create the issue, persist its identity, deliver the notification, and record the message mapping. The existing `fj issue` wrapper already passes unrecognized subcommands to `gh`; extend `fj issue create` rather than introducing a competing command. Fuzzy prioritization and drafting remain agent work. A manual caller must not acquire a fabricated agent identity by supplying an arbitrary label.

GitHub creation and Telegram delivery are separate outcomes. If the issue exists but notification fails, retry only the notification. If creation has an uncertain outcome, reconcile remote state before retrying; do not create duplicates. Notification delivery is not evidence that issue content was accepted as a new permission or that a human agreed to do the work.

## Reliability and execution boundaries

- Plans and revisions survive agent restart, reload, and compaction; chat is not their sole storage.
- A missed scheduled report is observable. Recovery reports its true window rather than inventing an on-time delivery.
- Retries do not create duplicate plans, corrections, issues, or messages.
- Report collection is bounded. An unavailable role or GitHub source yields a partial report with explicit omissions, not a false empty result.
- Pending planning questions do not stop unrelated executable work.
- Repeated unchanged blocked work does not create a busy loop.
- Ceremonies do not repair, depend on, or silently enable the current throttling system. Provider limits and existing safety/resource guards still apply.

## Read-only group sharing

This is the next increment after owner-only planning works.

Publish only an explicitly team-visible projection of plans and results to the configured group. Use an allowlist of approved fields: shared outcomes, issue references, dependencies, and assigned project-role work. Per-person report views, detailed capacity, and working-day availability remain private by default unless explicitly selected for that audience. Owner correspondence and reasons for personal unavailability are not group report content. Do not mirror private conversation, all registry traffic, memories, or the question queue. Existing private channels remain private.

The group destination must be explicitly configured. Sending a report there must not change inbound authorization. Until a later separately reviewed control design exists, non-owner group traffic must not enqueue AI turns, answer owner question cards, mutate plans, or invoke tools.

The initial implementation may keep all owner corrections in the existing private channel. Supporting owner control from the group is a separate choice requiring sender authentication and plan binding; it is not necessary for read-only sharing. Read-only automation access does not prohibit human discussion in the group: non-owner discussion is not an AI command or an approved planning correction.

### Agent topics and task threads

When topic support is introduced, each team-visible agent has a dedicated group topic. Its team-visible questions, reports, and reminders use the same destination. Adding a team-visible task publishes a root message in that topic; subsequent task replies are sent as replies to the original task message, not as unrelated posts.

Reaction additions, changes, and removals on agent-authored messages should notify the originating agent through the same durable message mapping, in private chats as well as future topics. Include the referenced message and sender identity only when the transport provides it; anonymous or aggregate reactions must not be attributed to a guessed person. Deduplicate events and respect drafts and manual pauses. Reactions are feedback, not question answers, approvals, or execution authority. Verify transport support and required permissions before enabling this path.

Question delivery preserves the question's stable identity and authorized-answer checks. Moving a question into a topic does not allow other participants to answer it on the owner's behalf. Reports and reminders retain their intended audience and delivery records. Personal questions, reports, and reminders remain with the personal bot in private DMs unless explicitly selected for team sharing.

Persist the association between the stable project/agent/task identity and the destination chat, topic, and root message. A local task number alone is not unique across agents. Session restarts must preserve the association, and known delivery retries must not create duplicate roots or replies. If a send outcome is uncertain, reconcile it rather than blindly posting another root.

If a mapped topic or root message is unavailable, retain the pending update and report the delivery problem; do not silently reroute it to the general group or a private chat. Only team-visible task content is projected. Private personal tasks, owner correspondence, and raw internal policy/debugging notes are not mirrored. Human replies in these threads do not gain command authority from being attached to a task.

## Separate personal and team spaces

Retain the personal bot and private conversation. Introduce a separate bot for the remotely hosted team setup when that environment is ready. Separate bot identities help people select the intended context; they do not establish authorization, data isolation, or exclusive task ownership by themselves.

The team bot receives team-visible plans and project context. Personal planning remains private. Agreed team commitments can be imported into the personal plan by stable reference rather than copied into a second independently editable commitment. Personal availability can be shared back only under explicit scope; private event descriptions and the reasons for unavailable time remain private by default.

The two systems must not independently pick up the same shared work. Before remote execution, define one authoritative shared claim mechanism using canonical work identities linked to GitHub. Claims must be atomic and distinguish execution phase and owner. GitHub labels, bot messages, and two unrelated local registries are not an exclusive claim protocol.

Loss of coordination cannot be treated as permission to take unclaimed work. Lease expiry alone does not prove a previous executor stopped: uncertain in-flight work must be reconciled before reassignment, and stale holders must be fenced from subsequent shared effects. Independent private tasks may continue within their existing scope. The concrete ownership and failure protocol belongs in the remote-hosting design, not the initial reporting implementation.

## Private personal planning follow-on

After team planning works, support private weekly and daily planning that incorporates agreed work alongside personal goals. This is a separate increment, not a prerequisite for the team workflow.

Prefer a resilient plan over exhaustive minute-by-minute allocation:

- Fixed commitments retain their times and constraints.
- Flexible goals record relative priority, rough effort, deadlines or minimum frequency where relevant, and preferred windows.
- Unallocated buffer absorbs ordinary disruption; an unfilled calendar is not automatically a planning failure.
- A disruption produces explicit alternatives to shorten, move, defer, or drop flexible activities, with consequences for the remaining week.
- The owner chooses an adjustment before calendar mutations. The system does not silently trade away fixed commitments or team promises.

Calendar and notification updates are a later authorized integration. Each approved adjustment names the affected events and reminders. Compare current calendar state with the approved proposal before applying it, detect conflicts, preserve timezone semantics, and make retries idempotent. Partial failures remain visible and require reconciliation; never claim the entire calendar or all reminders were updated after partial success. Superseded reminders must not continue notifying as if the old plan were current.

## Later work and non-goals

- Hard allocations, token quotas, or throttling repair.
- Full remote hosting, tenant isolation, employee command/control, or permission delegation.
- Personal calendar/notification integration in the initial team-planning increment.
- A new planner/research/development/review-agent organization.
- Automatic merges, review verdicts, or new publication authority.
- OKRs or a heavyweight sprint methodology.
- Replacing every historical note or migrating every old task at once.
- Rewriting project product requirements through a planning report.

## Acceptance scenarios

1. Given a saved daily commitment and later delivery evidence, the next report distinguishes planned, achieved, and carried-over outcomes without reconstructing the original plan after the fact.
2. Given two projects competing for attention, one weekly plan shows their ordering, separate human/agent constraints, flexible targets, and explicitly deferred outcomes.
3. Given a blocked top item, its role continues the next independently authorized ready item and records the deviation without claiming it met the blocked commitment.
4. Given an authenticated correction to plan revision N, revision N+1 preserves N, updates only the intended scope, and records per-role acknowledgment; replay produces no duplicate change.
5. Given a missing project update or incomplete GitHub collection, the report labels the omission and never claims complete coverage or no remaining work.
6. Given a local implementation task, its issue and SPEC/ROADMAP links are discoverable; a one-off exception is explicit and recurring work is flagged for refinement.
7. Given a restart or missed schedule, the saved plan, true report window, revision history, and delivery state remain recoverable.
8. Given a disabled or unavailable throttle, planning and reporting still operate without changing provider admission policy.
9. Given an employee message or callback in the read-only group, no AI turn, plan mutation, question resolution, or tool execution occurs.
10. Given a team-visible report, private owner messages, internal raw logs, and non-shareable notes are absent.
11. Given independently changing participant timezones, existing plan intervals remain stable and each participant receives the appropriate view without duplicate reports or a mandatory shared response window.
12. Given weekend planning and a teammate who does not work weekends, agents proceed on proposed authorized priorities without assigning weekend work to that teammate or waiting for their response.
13. Given an authorized planning deliverable and a public-safe issue payload, issue creation proceeds without exact-phrasing approval, followed by an attributed Telegram notification; deferred review findings retain their separate approval gate.
14. Given private material in any public payload field, publication is held or the draft is rewritten and rechecked before creation, without blocking unrelated planning.
15. Given successful issue creation followed by failed notification delivery, recovery sends the notification for the existing issue instead of creating another issue.

Follow-on acceptance boundaries:

- Two machines attempting the same shared execution item cannot both acquire it; lost coordination or uncertain previous execution does not permit automatic reassignment.
- A personal disruption proposal preserves fixed commitments and identifies tradeoffs without mutating the calendar before approval.
- An approved adjustment updates only its bound calendar events and reminders; replay, intervening calendar edits, and partial transport failures do not duplicate or silently overwrite work.
- Importing team commitments into a private plan does not disclose private activities, event descriptions, or availability reasons to the team.
- Adding a team-visible task creates one root in its agent's topic; later task replies target that root after restarts, while unavailable destinations and uncertain send outcomes remain visible rather than creating duplicate or misrouted posts.

## Decisions still to confirm

- Private per-participant current timezone, working-day settings, and preferred delivery window before activating reminders; the asynchronous weekly cadence is confirmed.
- Confirmation of the proposed single existing-agent coordinator and separate human/autonomous report views.
- Exact durable plan representation and delivery adapter, selected during implementation design rather than inferred from the current chat UI.
- Telegram group destination and the scope of team-visible project information, before any group delivery.
- Calendar provider, notification channel, and protected/flexible personal-planning rules before calendar integration.

## Existing references

- [Durable backlog reconciliation](extensions/agent-registry/BACKLOG-RECONCILIATION-DESIGN.md): local role ownership, source coverage, lifecycle evidence, and the existing registry boundary.
- [Telegram topic proposal](../../adrs/09-telegram-topics-as-the-routing-key.md): routing proposal, not proof of implemented group support or multi-user authorization.
- [Current Telegram contract](extensions/remote-control/TELEGRAM.md): existing owner-only boundary; group operation is currently a documented non-goal.
- [Existing EOD skill](../skills/eod/SKILL.md): evidence and stakeholder-delivery conventions, distinct from this plan-versus-outcome planning workflow.
