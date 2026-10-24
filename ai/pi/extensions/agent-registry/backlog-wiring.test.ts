import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("registry sync emits one bounded external projection and reconciles branch todo events", () => {
  assert.match(source, /await run\(store\.backlogSnapshot\(ctx\.cwd\)\)/)
  assert.match(source, /externalBacklogProjection\(state, project\)/)
  assert.match(
    source,
    /pi\.events\.emit\(BACKLOG_PROJECTION_EVENT, backlogEvent\)/,
  )
  assert.match(source, /pi\.events\.on\(BRANCH_TODO_BACKLOG_EVENT/)
  assert.match(source, /store\.reconcileBranchTodos\(snapshot\)/)
  assert.match(source, /backlogCoverage\.unreconciledSources\(project\)/)
  assert.match(source, /pi\.events\.on\(MESSAGE_BACKLOG_EVENT/)
  assert.match(source, /store\.ingestMessage\(message\)/)
  assert.match(source, /pi\.events\.on\(CANONICAL_BACKLOG_EVENT/)
  assert.match(source, /store\.reconcileCanonicalBacklog\(snapshot\)/)
  assert.match(source, /snapshot\.coverage === "complete"/)
  assert.match(source, /backlogCoverage\.markSource\(/)
  assert.match(
    source,
    /event\.source === "interactive"[\s\S]*?!trimmed\.startsWith\("\/"\)[\s\S]*?backlogRequirementsFromText\(event\.text\)[\s\S]*?await ingestMessageBacklog[\s\S]*?source: "owner-message"[\s\S]*?authority: "authenticated-owner"/,
  )
})

test("registry tool persists validated declared backlog sources before success", () => {
  assert.match(source, /Type\.Literal\("ingest_backlog"\)/)
  assert.match(source, /backlogSnapshotFromToolRequest\(/)
  assert.match(
    source,
    /await run\(store\.reconcileCanonicalBacklog\(snapshot\)\)/,
  )
  assert.match(source, /backlogCoverage\.markSource\(/)
  assert.match(source, /emitBacklogProjection\(state, snapshot\.project/)
})

test("trusted project startup collects only explicitly declared backlog sources model-free", () => {
  assert.match(source, /collectDeclaredBacklogSources\(\{/)
  assert.match(source, /configDirName: CONFIG_DIR_NAME/)
  assert.match(source, /trusted: ctx\.isProjectTrusted\(\)/)
  assert.match(source, /makeDeclaredBacklogFileReader\(ctx\.cwd, signal\)/)
  assert.match(source, /collectGitHub: declared =>/)
  assert.match(source, /collectDeclaredGitHubBacklog\(\{/)
  assert.match(
    source,
    /makeDeclaredBacklogCommandRunner\([\s\S]*?signal,[\s\S]*?observedAt \+ BACKLOG_COLLECTION_TIMEOUT_MS/,
  )
  assert.match(source, /store\.reconcileCanonicalBacklog\(snapshot\)/)
  assert.match(source, /epoch !== activeLifecycleEpoch \|\| signal\.aborted/)
  assert.match(source, /backlogCollectorAbort\?\.abort\(\)/)
  assert.match(source, /void collectDeclaredBacklog\(/)
  assert.doesNotMatch(source, /await collectDeclaredBacklog\(/)
  assert.match(
    source,
    /backlogCoverage\.invalidateDeclared\(ctx\.cwd\)[\s\S]*?collectDeclaredBacklogSources\(/,
  )
  assert.match(
    source,
    /Either\.isLeft\(result\)[\s\S]*?store\.backlogSnapshot\(ctx\.cwd\)[\s\S]*?emitBacklogProjection/,
  )
  assert.match(
    source,
    /state \?\? \(await run\(store\.backlogSnapshot\(ctx\.cwd\)\)\)/,
  )
  assert.match(source, /session_start[\s\S]*?backlogCoverage\.reset\(\)/)
})
