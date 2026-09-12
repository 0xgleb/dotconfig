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

test("EOD collector exposes explicit project scope without a retired tracker dependency", () => {
  const result = spawnSync(
    "nu",
    [
      new URL("../skills/eod/scripts/collect.nu", import.meta.url).pathname,
      "--help",
    ],
    { encoding: "utf8", timeout: 10_000 },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /--workspace/)
  assert.match(result.stdout, /--owners/)
  assert.match(result.stdout, /GitHub organization logins/)
  assert.doesNotMatch(
    result.stdout,
    /--linear-repo|ST0x-Technology|rainlanguage|\/code\/st0x/,
  )
  assert.doesNotMatch(
    collector,
    /run-linear-json|collect-linear|source_status\.linear/,
  )
})

test("EOD rejects missing or malformed scope before external collection", () => {
  const discovery = spawnSync("nu", ["--commands", "$nu.current-exe"], {
    encoding: "utf8",
  })
  assert.equal(discovery.status, 0, discovery.stderr)
  const executable = discovery.stdout.trim()
  assert.match(executable, /^\/[^\r\n]+$/)
  const script = new URL("../skills/eod/scripts/collect.nu", import.meta.url)
    .pathname
  const window = [
    "--since",
    "2026-07-10T00:00:00Z",
    "--until",
    "2026-07-11T00:00:00Z",
  ]
  for (const [scope, expected] of [
    [[], /--workspace is required/],
    [["--workspace", "/workspace/not-accessed"], /--owners is required/],
    [
      ["--workspace", "/workspace/not-accessed", "--owners", ","],
      /--owners contains an invalid owner/,
    ],
    [
      ["--workspace", "/workspace/not-accessed", "--owners", "example"],
      /--workspace must be an existing directory/,
    ],
  ] as const) {
    const result = spawnSync(executable, [script, ...window, ...scope], {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: "", HOME: "/nonexistent" },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr + result.stdout, expected)
  }
})

test("EOD validates explicit historical batch selectors before external collection", () => {
  const discovery = spawnSync("nu", ["--commands", "$nu.current-exe"], {
    encoding: "utf8",
  })
  assert.equal(discovery.status, 0, discovery.stderr)
  const executable = discovery.stdout.trim()
  assert.match(executable, /^\/[^\r\n]+$/)
  const script = new URL("../skills/eod/scripts/collect.nu", import.meta.url)
    .pathname
  const workspace = new URL("../skills/eod", import.meta.url).pathname
  const command = `source ${JSON.stringify(script)}\nmain --since "2026-07-10T00:00:00Z" --until "2026-07-11T00:00:00Z" --workspace ${JSON.stringify(workspace)} --owners "example" --graphite-batches ["example/service#1:2" "not-a-spec"]`
  const result = spawnSync(executable, ["--commands", command], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: "", HOME: "/nonexistent" },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /Invalid Graphite batch spec/)
})

test("EOD end-to-end report contract requires exact approval and verified delivery", () => {
  const result = spawnSync("nu", [reportContractTest.pathname], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /All 5 tests passed/)
})

test("EOD is Telegram-only and never uses Obsidian as a prerequisite or mutation surface", () => {
  const skillFrontmatter = eod.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""

  assert.match(eod, /directly on Telegram/i)
  assert.match(eod, /never require or modify Obsidian/i)
  assert.match(
    eod,
    /do\s+not discover, read, create, or modify an Obsidian note/is,
  )
  assert.doesNotMatch(skillFrontmatter, /(?:^|\s)- "(?:Edit|Write)"$/m)
  assert.doesNotMatch(skillFrontmatter, /find .*Obsidian/is)
  assert.doesNotMatch(eod, /Obsidian markdown note is the drafting/i)
  assert.doesNotMatch(eod, /existing zero-byte/i)
})

test("EOD derives a verified reporting window without requiring a note", () => {
  assert.match(eod, /latest successful prior EOD delivery/i)
  assert.match(eod, /typed `deliver_stakeholder_update`.*`outcome=delivered`/is)
  assert.match(eod, /explicit starting point\s+supplied by the user/is)
  assert.match(eod, /ask for the starting point rather\s+than inventing/is)
  assert.match(eod, /same exact\s+`since` and `until` timestamps/is)
})

test("EOD excludes status-only issue and deployment noise without user involvement", () => {
  assert.match(eod, /issue merely closing is context, not proof/i)
  assert.match(eod, /deployment workflow is context, not user work by itself/i)
  assert.match(eod, /verified_user_involvement/)
  assert.match(eod, /`context_only`/)
  assert.doesNotMatch(collector, /linear-reportability/)
  assert.match(eod, /does\s+not collect GitHub issue activity/i)
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

test("EOD requires approval of the exact draft before typed Telegram delivery", () => {
  assert.match(
    eod,
    /Present the exact stakeholder-forwardable draft for owner approval/i,
  )
  assert.match(
    eod,
    /request to\s+prepare or correct an EOD is not delivery approval/is,
  )
  assert.match(eod, /byte-for-byte the approved content/i)
  assert.match(eod, /deliver_stakeholder_update/)
  assert.doesNotMatch(
    eod,
    /send the exact verified update through the\s+typed `report_owner`/,
  )
  assert.match(eod, /outcome=delivered/)
  assert.match(eod, /do not claim the EOD is\s+complete/i)
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

test("EOD excludes local stash commits from linked GitHub evidence", () => {
  assert.match(
    collector,
    /git\s+-C\s+\$repo\s+log\s+'--exclude=refs\/stash'\s+--all/,
  )
  assert.doesNotMatch(collector, /git\s+-C\s+\$repo\s+log\s+--all/)
})

test("EOD uses bounded Pi session framing without trusting assistant claims", () => {
  assert.match(eod, /bounded `session_search`/i)
  assert.match(
    eod,
    /user_framing.*user_correction.*verified_tool_result.*assistant_claim/is,
  )
  assert.match(eod, /Assistant summaries and claims are discovery hints only/i)
  assert.match(eod, /future event-log\s+adapter/i)
  assert.match(eod, /do not add an\s+event-log dependency now/i)
  assert.match(eod, /never read raw.*Pi transcript files/is)
})
