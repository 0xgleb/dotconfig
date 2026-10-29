import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const global = readFileSync(
  new URL("../../GLOBAL_AGENTS.md", import.meta.url),
  "utf8",
).replace(/\s+/gu, " ")
const project = readFileSync(
  new URL("../../AGENTS.md", import.meta.url),
  "utf8",
).replace(/\s+/gu, " ")

const forGlobal = (reason: string) => `GLOBAL_AGENTS.md must ${reason}`

test("global instructions resist confirmation bias", () => {
  assert.match(global, /do not mirror.*latest framing|agree reflexively/is)
  assert.match(global, /counter-hypothesis/i)
  assert.match(global, /do not oscillate.*without changed/is)
  assert.match(global, /inspect existing code.*doc/is)
  assert.match(global, /correct prior unsupported/i)
})

test("owner-identified mistakes generalize within the current authorized work unit", () => {
  assert.match(
    global,
    /check the entire current authorized work unit for every other instance of that mistake class/is,
    forGlobal("generalize the correction within the assigned unit"),
  )
  assert.doesNotMatch(global, /other live worker backlogs, relayed tasks/is)
  assert.match(
    global,
    /Repairing only the named instance is itself a\s+failure/is,
    forGlobal("treat single-instance repair as failure"),
  )
  assert.match(
    global,
    /Report out-of-scope instances and proposed capability follow-ups to the manager/is,
    forGlobal("route proposed follow-ups to the manager"),
  )
  assert.match(global, /do not create or start additional work/is)
  assert.match(
    global,
    /standing owner rule applies globally, not only\s+in the conversation that surfaced the example/is,
    forGlobal("apply the scoped correction duty everywhere"),
  )
})

test("task priority lives only in the rank field", () => {
  assert.match(
    global,
    /priority only through the backlog tool's priority\/rank field/is,
    forGlobal("assign priority through the rank field"),
  )
  assert.match(
    global,
    /Never encode priority in task titles, text, or prose/is,
    forGlobal("forbid priority prose in task text"),
  )
  assert.match(
    global,
    /The rank field is the\s+single ordering authority/is,
    forGlobal("keep one ordering authority"),
  )
})

test("driver workers publish checkpoints early without granting reviewer or manager authority", () => {
  assert.match(global, /Driver workers.*commit and push regularly/is)
  assert.match(global, /draft PR with the first checkpoint/is)
  assert.match(global, /incomplete or broken.*failing checks/is)
  assert.match(global, /checks pass for the\s+published head/is)
  assert.match(global, /Review workers and managers are exempt/is)
  assert.match(global, /does not grant them coding or publication authority/is)
})

test("PR readiness follows the required local or CI verification workflow", () => {
  assert.ok(
    /all project-required checks pass for the published head/is.test(global),
  )
  assert.ok(/Follow the repository's verification workflow/is.test(global))
  assert.ok(
    /Local verification is sufficient when that workflow uses local checks instead of CI/is.test(
      global,
    ),
  )
  assert.ok(
    /failing, pending, or unverified required checks keep the PR draft/is.test(
      global,
    ),
  )
  assert.doesNotMatch(global, /every CI check must succeed/is)
})

test("Markdown formatting uses Deno instead of Prettier", () => {
  assert.ok(/Use `deno fmt` for Markdown, not Prettier/is.test(global))
})

test("PR descriptions follow the template without invented sections", () => {
  assert.match(global, /Preserve its headings and required content/is)
  assert.match(global, /Do not add sections absent from the template/is)
  assert.match(
    global,
    /When no template exists, use only Motivation \/ Solution/is,
  )
})

test("only managers assign owner-confirmed priorities and workers follow backlog order", () => {
  assert.match(global, /Only the manager may assign or change.*priorities/is)
  assert.match(global, /only after the owner confirms/is)
  assert.match(
    global,
    /Workers must execute the highest-ranked.*runnable work/is,
  )
  assert.match(global, /not insert self-chosen audits/is)
  assert.match(global, /does not authorize new audit tasks.*reprioritization/is)
})

test("global TypeScript guidance keeps failures in typed Effect channels", () => {
  assert.match(global, /`Effect\.try`\/`Effect\.tryPromise`/)
  assert.match(
    global,
    /Return domain and expected\s+failures directly with `Effect\.fail` and recover through typed Effect\s+handlers/is,
  )
  assert.match(global, /never use `throw` in production code/is)
})

test("global instructions separate user cancellation from agentops incidents", () => {
  assert.match(
    global,
    /quiet `cancelled:user` control flow,\s+not a harness failure/is,
  )
  assert.match(global, /Genuine errors remain an agentops\s+responsibility/is)
  assert.match(
    global,
    /without requiring the user to\s+notice or repeat them/is,
  )
})

test("global instructions enforce disk-pressure hygiene", () => {
  assert.match(global, /resource-pressure guard.*authoritative.*preflight/is)
  assert.match(global, /Do not poll `df`.*`vm_stat`.*process lists/is)
  assert.match(global, /agent-(?:created|owned).*artifact/is)
  assert.match(global, /artifact_provenance/is)
  assert.match(
    global,
    /never.*global.*(?:cache|garbage collection).*without explicit/is,
  )
})

test("global instructions route work through the agent registry", () => {
  assert.match(
    global,
    /Inspect the live registry destination\s+before delegation/is,
  )
  assert.match(global, /A role\s+grants no capability/i)
  assert.match(
    global,
    /operational duties do not end when an inbox is\s+empty/is,
  )
  assert.match(
    global,
    /Registry failure blocks only operations requiring its ownership or\s+transitions/is,
  )
})

test("global instructions prohibit overwriting the active editor", () => {
  assert.match(
    global,
    /Never inject keystrokes or text into the user's active/is,
  )
  assert.match(global, /reload_pi/)
})

test("global instructions preserve focus for background delegation", () => {
  assert.match(global, /snapshot the user's active\s+tab and pane/is)
  assert.match(global, /restore that exact focus before\s+returning/is)
  assert.match(
    global,
    /cannot be verified, use a classified\s+background workflow/is,
  )
})

test("global instructions forbid stopping with active work", () => {
  assert.match(
    global,
    /continue until assigned work is complete or remaining work has\s+concrete blockers/is,
  )
})

test("global instructions continue safely after classifier blocks", () => {
  assert.match(global, /A block is not permission to stop/is)
  assert.match(global, /Never invent `--force` or equivalent bypass flags/is)
  assert.match(global, /return to the real active task through a\s+safe path/is)
})

test("global instructions require one evidence-backed PR category label", () => {
  assert.match(
    global,
    /Apply exactly\s+one verified category label: fixes use `bug`, test-only changes `test`,/is,
  )
  assert.match(global, /never combine categories\s+to hedge/is)
  assert.match(
    global,
    /Resolve only evidenced AI-authored review threads after\s+verification/is,
  )
})

test("global instructions prepare and resume safe compaction", () => {
  assert.match(global, /safe compaction preparation.*persist critical state/is)
  assert.match(global, /`safe_compaction_ready` with the exact next action/is)
  assert.match(
    global,
    /tool call with\s+no successful tool result was not executed/is,
  )
  assert.match(
    global,
    /After compaction, resume that\s+action.*continue all assigned work/is,
  )
})

test("global instructions preserve manual interrupt pauses", () => {
  assert.match(global, /manual user interrupt|double-cancel/i)
  assert.match(
    global,
    /Do not\s+automatically resume.*until the user submits\s+their next prompt/is,
  )
})

test("global instructions enforce handover ingestion", () => {
  assert.match(global, /\/handover/)
  assert.match(global, /receiv(?:e|ing).*handover/is)
  assert.match(global, /(?:every|all).*transferred request/is)
  assert.match(global, /todo list/i)
})

test("workspace publication includes owner and peer changes regardless of the active task", () => {
  assert.match(
    global,
    /agent responsible for a GitButler workspace.*publication of all pending tracked and untracked project changes/is,
  )
  assert.match(global, /including changes made by the owner or other agents/is)
  assert.match(global, /unrelated to the agent's current task/is)
  assert.match(
    global,
    /inspect and group.*reconcile conflicts.*commit.*push.*open or update.*PRs/is,
  )
  assert.match(global, /does not authorize unrelated implementation/is)
})

test("related discovered changes reuse an existing branch and PR", () => {
  assert.match(
    global,
    /Reuse an existing branch and PR when the changes are related/is,
  )
  assert.match(
    global,
    /Discovering more changes does not require a new branch or PR/is,
  )
  assert.match(
    global,
    /only for independent work without a suitable ongoing branch/is,
  )
})

test("cross-project harness edits remain direct source changes without foreign VCS writes", () => {
  assert.match(
    global,
    /agents assigned to other projects.*source edits directly in `~\/.config`/is,
  )
  assert.match(
    global,
    /leave them uncommitted.*agent responsible for that workspace/is,
  )
  assert.match(
    global,
    /do not commit, push, create PRs, or otherwise mutate dotconfig VCS state/is,
  )
})

test("dotconfig refers to global delivery policy rather than duplicating publication ownership", () => {
  assert.match(
    project,
    /Follow the workspace publication and delivery rules in `GLOBAL_AGENTS.md`/is,
  )
  assert.doesNotMatch(
    project,
    /Shared-edit publication ownership|must pick up these changes/is,
  )
  assert.match(
    project,
    /Direct-to-master delivery requires explicit owner direction/is,
  )
})
