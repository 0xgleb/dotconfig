import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import test from "node:test"

const eod = readFileSync(
  new URL("../skills/eod/SKILL.md", import.meta.url),
  "utf8",
)
const collector = readFileSync(
  new URL("../skills/eod/scripts/collect.nu", import.meta.url),
  "utf8",
)
const reportContractTest = new URL(
  "../skills/eod/scripts/report-contract.test.nu",
  import.meta.url,
)

test("EOD end-to-end report contract preserves concurrent edits and rejects unsupported claims", () => {
  const result = spawnSync("nu", [reportContractTest.pathname], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /All 5 tests passed/)
})

test("EOD safely initializes an explicitly selected zero-byte note without overwriting content", () => {
  assert.match(eod, /allowed-tools:[\s\S]*?- "Write"/)
  assert.match(eod, /existing zero-byte.*use `Write`/is)
  assert.match(eod, /nonempty.*use `Edit`/is)
  assert.match(eod, /never.*`Write`.*nonempty/is)
})

test("EOD supports bounded note discovery when Pi has no Glob tool", () => {
  assert.doesNotMatch(eod, /^\s*- "?Glob"?\s*$/m)
  assert.match(eod, /In Pi, use this exact bounded discovery command/i)
  assert.match(eod, /find .*notes.*-name '\*-eod\.md'/is)
  assert.match(eod, /not a broad filesystem search/i)
  for (const exclusion of [
    ".env*",
    "*credential*",
    "*secret*",
    "*private*key*",
    "*.pem",
    "*.key",
    "*.crt",
    "*.cer",
    "*.p12",
    "*.pfx",
  ]) {
    assert.match(eod, new RegExp(exclusion.replaceAll("*", "\\*"), "i"))
  }
})

test("EOD excludes status-only Linear and deployment noise without user involvement", () => {
  assert.match(eod, /issue merely entering Done is context, not proof/i)
  assert.match(eod, /deployment workflow is context, not user work by itself/i)
  assert.match(eod, /verified_user_involvement/)
  assert.match(eod, /`context_only`/)
  assert.match(collector, /linear-reportability/)
  assert.match(collector, /deployment-reportability/)
  assert.match(collector, /authored_pr_refs/)
})

test("EOD uses stakeholder headers and reference-adjacent counts", () => {
  assert.match(eod, /meaningful stakeholder headers/i)
  assert.match(
    eod,
    /Never emit generic headings.*`What Was Done`.*`Review hardening`/is,
  )
  assert.match(eod, /never create a one-bullet section.*project name/is)
  assert.match(eod, /Never emit a detached stats line/i)
  assert.match(eod, /same sentence or\s+bullet as the exact supporting/is)
})

test("EOD preserves concurrent manual edits through live anchor-only patches", () => {
  assert.match(
    eod,
    /re-read the live target immediately before every mutation/i,
  )
  assert.match(
    eod,
    /use `Edit` only on the exact placeholder or\s+user-requested anchor/is,
  )
  assert.match(eod, /never\s+reconstruct the note from the earlier snapshot/is)
})

test("EOD uses Obsidian as staging and requires verified Telegram delivery", () => {
  assert.match(eod, /Obsidian.*drafting and staging surface/is)
  assert.match(eod, /deliver_stakeholder_update/)
  assert.doesNotMatch(
    eod,
    /send the exact verified update through the\s+typed `report_owner`/,
  )
  assert.match(eod, /outcome=delivered/)
  assert.match(eod, /do not claim the EOD is\s+complete/i)
  assert.doesNotMatch(eod, /Never send or post the update to Telegram/i)
  assert.doesNotMatch(eod, /Writing the note is the entire external boundary/i)
})

test("EOD reconciles exact Graphite batches instead of broad merged searches", () => {
  assert.match(eod, /--graphite-batches/)
  assert.match(collector, /collect-graphite-batches/)
  assert.match(collector, /parse-graphite-batch-spec/)
  assert.match(collector, /graphite-pr-reportability/)
  assert.match(eod, /OWNER\/REPO#GROUP:CHILD,CHILD/)
  assert.match(
    eod,
    /Never replace this bounded\s+scope with broad `is:merged`, `mergedAt`/is,
  )
  assert.match(eod, /`merged_via_graphite_batch`/)
  assert.match(eod, /Do not count the group as\s+an additional authored PR/is)
})

test("EOD uses bounded Pi session framing without trusting assistant claims", () => {
  assert.match(eod, /bounded `session_search`/i)
  assert.match(
    eod,
    /user_framing.*user_correction.*verified_tool_result.*assistant_claim/is,
  )
  assert.match(eod, /Assistant summaries and claims are discovery hints only/i)
  assert.match(eod, /future event-log\s+adapter/i)
  assert.match(eod, /do not add an\s+event-sorcery dependency now/i)
  assert.match(eod, /never read raw.*Pi transcript files/is)
})
