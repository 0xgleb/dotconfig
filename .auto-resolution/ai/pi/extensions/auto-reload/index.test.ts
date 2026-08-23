import assert from "node:assert/strict"
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createReloadExecutionScheduler,
  createManagedGenerationReconciler,
  createManagedGenerationTracker,
  managedGeneration,
} from "./index.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

test("post-reload continuation waits for a later idle macrotask without owning the composer", () => {
  assert.match(source, /setTimeout\(deliverWhenSettled, 0\)/)
  assert.match(
    source,
    /agentRunActive \|\| !ctx\.isIdle\(\) \|\| managedWorkIsActive\(\)/,
  )
  assert.match(
    source,
    /reloadContinuationTimer = setTimeout\([\s\S]*?IDLE_RETRY_MS/,
  )
  assert.match(
    source,
    /pi\.sendMessage\(message, \{ triggerTurn: true, deliverAs \}\)/,
  )
  assert.match(source, /ctx\.ui\.getEditorText\(\)\.length > 0/)
  assert.match(source, /ctx\.hasPendingMessages\(\)/)
  assert.match(
    source,
    /pi\.sendMessage\(message, \{ deliverAs: "nextTurn" \}\)/,
  )
  assert.doesNotMatch(
    source,
    /delivery === "resume"[\s\S]{0,160}pi\.sendMessage\(message, \{ triggerTurn: true/,
  )
})

test("reload degradation is automatically routed as an agentops incident", () => {
  assert.match(source, /AGENTOPS_INCIDENT_EVENT/)
  assert.match(
    source,
    /component: "auto-reload"[\s\S]*?operation[\s\S]*?summary/,
  )
  assert.match(
    source,
    /reportIncident\([\s\S]*?"error",[\s\S]*?"refresh model catalog after reload"/,
  )
  assert.match(source, /"automatic extension reload"/)
  assert.match(source, /Automatic Pi reload failed/)
  assert.match(source, /reportIncident\("warning", "reload context preflight"/)
  assert.match(
    source,
    /reportIncident\([\s\S]*?"warning",[\s\S]*?"watch managed Pi resources"/,
  )
})

test("pending managed reload re-enters safe idle admission at agent end", () => {
  const agentEnd = source.indexOf('pi.on("agent_end"')
  const agentSettled = source.indexOf('pi.on("agent_settled"')
  assert.ok(agentEnd > 0)
  assert.ok(agentEnd < agentSettled)
  assert.match(
    source,
    /if \(!pending \|\| !isReloadableContext\(ctx\)\) return;?/,
  )
  assert.match(
    source,
    /if \(Date\.now\(\) - lastChangeAt < SETTLE_MS\) return;?/,
  )
  const handler = source.slice(agentEnd, agentSettled)
  assert.match(handler, /await reloadWhenIdle\(ctx\)/)
  assert.doesNotMatch(handler, /reloadExecutionScheduler\.request\(ctx\)/)
})

test("reload waits until the current extension event dispatch has completed", async () => {
  const events = ["auto-reload handler"]
  let resolveReloaded: (() => void) | undefined
  const reloaded = new Promise<void>(resolve => {
    resolveReloaded = resolve
  })
  const scheduler = createReloadExecutionScheduler(async (ctx: string) => {
    events.push(`reload ${ctx}`)
    resolveReloaded?.()
  })

  scheduler.request("context")
  events.push("later extension handler")

  assert.deepEqual(events, ["auto-reload handler", "later extension handler"])
  await reloaded
  assert.deepEqual(events, [
    "auto-reload handler",
    "later extension handler",
    "reload context",
  ])
  scheduler.close()
})

test("reload cannot invalidate a live agent, draft, queue, or compaction", () => {
  assert.match(source, /let agentRunActive = false/)
  assert.match(
    source,
    /pi\.on\("agent_start", \(\) => \{\s*agentRunActive = true\s*\}\)/,
  )
  assert.match(source, /reloadComposerIsSafe/)
  assert.match(source, /ctx\.ui\.getEditorText\(\)/)
  assert.match(source, /ctx\.hasPendingMessages\(\)/)
  assert.match(source, /Date\.now\(\) - composerSafeSince < COMPOSER_QUIET_MS/)
  assert.match(
    source,
    /idle: !agentRunActive && ctx\.isIdle\(\) && composerQuiet/,
  )
})

test("deferred reload rechecks idle admission after a new agent run wins the scheduling race", () => {
  const performReload = source.indexOf("const performReload")
  const clearPending = source.indexOf("pending = false", performReload)
  const reload = source.indexOf("await ctx.reload()", performReload)

  assert.ok(performReload > 0)
  assert.match(
    source.slice(performReload, clearPending),
    /!composerSafe[\s\S]*?composerSafeSince === undefined[\s\S]*?COMPOSER_QUIET_MS/,
  )
  assert.ok(clearPending > performReload)
  assert.ok(reload > clearPending)
})

test("long-running turns wait for an idle boundary without managed preemption", () => {
  assert.match(source, /AUTO_RELOAD_ACTIVITY_REQUEST_EVENT/)
  assert.match(source, /managedReloadDecision/)
  assert.match(
    source,
    /idle: !agentRunActive && ctx\.isIdle\(\) && composerQuiet/,
  )
  assert.doesNotMatch(source, /ctx\.abort\(\)/)
})

test("completed reloads render one terse change-dominant line", () => {
  assert.match(source, /registerMessageRenderer\(\s*COMPLETED_MESSAGE_TYPE/)
  assert.match(source, /managedReloadDisplayText\(/)
  assert.match(source, /details: \{ displayText \}/)
  assert.doesNotMatch(
    source,
    /content: `Pi resources auto-reloaded after managed configuration changed/,
  )
})

test("completed reloads resume only when the composer is free", () => {
  assert.match(source, /ctx\.ui\.getEditorText\(\)\.length > 0/)
  assert.match(source, /ctx\.hasPendingMessages\(\)/)
  assert.match(source, /deliverAs: "nextTurn"/)
  assert.match(source, /triggerTurn: true/)
  assert.match(source, /deliverAs: "resume"/)
  assert.match(source, /deliverAs: "followUp"/)
  assert.match(source, /Resuming preserved work now/)
  assert.match(source, /user input remains available/)
  assert.doesNotMatch(source, /ctx\.abort\(\)/)
})

test("pending user gates consume stale interrupted-generation resumes without injecting a turn", () => {
  assert.match(source, /delivery === "displayAndConsumeResume"/)
  assert.match(
    source,
    /latestReloadResumeMarker\(branch\)\?\.requestedAt[\s\S]*?status: "resumed"/,
  )
})

test("managed reload refreshes active model metadata before resuming preserved work", () => {
  const refresh = source.indexOf("ctx.modelRegistry.refresh({")
  const reselect = source.indexOf("await pi.setModel(refreshedModel)")
  const resume = source.indexOf("pi.sendMessage(message")

  assert.ok(
    refresh > 0,
    "reload must refresh models.json for already-running sessions",
  )
  assert.match(source, /allowNetwork: false/)
  assert.match(
    source,
    /ctx\.modelRegistry\.find\([\s\S]*?activeModel\.provider,[\s\S]*?activeModel\.id,[\s\S]*?\)/,
  )
  assert.ok(
    reselect > refresh,
    "the selected model must be rebound from refreshed metadata",
  )
  assert.ok(
    resume > reselect,
    "preserved work must not resume against stale context limits",
  )
})

test("managed source events start settle-gated reload immediately instead of waiting on a fixed debounce", () => {
  assert.match(source, /queueMicrotask\(\(\) => void reloadWhenIdle\(ctx\)\)/)
  assert.doesNotMatch(source, /DEBOUNCE_MS/)
})

test("filesystem event bursts never synchronously rehash the full managed tree", () => {
  assert.doesNotMatch(
    source,
    /const scheduleReloadForChangedGeneration[\s\S]*?managedGeneration\(watchPaths\)/,
  )
  assert.doesNotMatch(
    source,
    /generationTimer = setInterval\(\(\) => \{\s*const nextGeneration = managedGeneration\(watchPaths\)/,
  )
})

test("managed generation hashes content only after metadata changes", () => {
  let metadata = "metadata:1"
  let content = "content:1"
  let metadataReads = 0
  let contentReads = 0
  const tracker = createManagedGenerationTracker([], {
    metadataGeneration: () => {
      metadataReads += 1
      return metadata
    },
    contentGeneration: () => {
      contentReads += 1
      return content
    },
  })

  assert.equal(tracker.reconcile(), "unchanged")
  assert.deepEqual(
    { metadataReads, contentReads },
    { metadataReads: 2, contentReads: 1 },
  )

  metadata = "metadata:2"
  assert.equal(tracker.reconcile(), "unchanged")
  assert.deepEqual(
    { metadataReads, contentReads },
    { metadataReads: 3, contentReads: 2 },
  )

  metadata = "metadata:3"
  content = "content:2"
  assert.equal(tracker.reconcile(), "content-changed")
  assert.deepEqual(
    { metadataReads, contentReads },
    { metadataReads: 4, contentReads: 3 },
  )
})

test("managed generation coalesces a realistic watcher event burst into one reconciliation", async () => {
  let reconciliations = 0
  const changedPaths: Array<string | null> = []
  const reconciler = createManagedGenerationReconciler({
    tracker: {
      reconcile: () => {
        reconciliations += 1
        return "content-changed"
      },
    },
    settleMs: 10,
    onContentChange: changedPath => changedPaths.push(changedPath),
  })

  reconciler.request("/managed/extensions/first.ts")
  reconciler.request("/managed/extensions/second.ts")
  reconciler.request("/managed/extensions/final.ts")
  reconciler.poll("/managed")
  await new Promise(resolve => setTimeout(resolve, 30))
  reconciler.close()

  assert.equal(reconciliations, 1)
  assert.deepEqual(changedPaths, ["/managed/extensions/final.ts"])
})

test("automatic reload waits for sources to settle, never for a clean working tree", () => {
  assert.match(source, /SETTLE_MS = 15_000/)
  assert.match(source, /settled: now - lastChangeAt >= SETTLE_MS/)
  assert.match(source, /reload:awaiting-settle/)
  assert.doesNotMatch(
    source,
    /managedSourcesAreCommitted/,
    "the git commit gate never opens under the worktree flow where the main checkout stays dirty",
  )
  assert.doesNotMatch(source, /git.*diff/)
})

test("managed generation ignores metadata-only source events", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-reload-"))
  try {
    const source = join(root, "sample.ts")
    writeFileSync(source, "export const value = 1;\n")
    const first = managedGeneration([root])
    const now = new Date()
    utimesSync(source, now, new Date(now.getTime() + 1_000))
    assert.equal(managedGeneration([root]), first)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("per-process managed generation detects nested in-place changes missed by directory mtimes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-reload-"))
  try {
    const nested = join(root, "extensions", "sample.ts")
    mkdirSync(join(root, "extensions"))
    writeFileSync(nested, "export const value = 1;\n")
    const first = managedGeneration([root])
    await new Promise(resolve => setTimeout(resolve, 10))
    writeFileSync(nested, "export const value = 2;\n")
    const second = managedGeneration([root])
    assert.notEqual(second, first)
    assert.equal(managedGeneration([root]), second)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
