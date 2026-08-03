import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedGeneration } from "./index.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("pending managed reload executes at agent end before continuous follow-ups can starve idle", () => {
  const agentEnd = source.indexOf('pi.on("agent_end"');
  const agentSettled = source.indexOf('pi.on("agent_settled"');
  assert.ok(agentEnd > 0);
  assert.ok(agentEnd < agentSettled);
  assert.match(source, /if \(!pending \|\| !isReloadableContext\(ctx\)\) return;/);
  assert.match(source, /if \(Date\.now\(\) - lastChangeAt < SETTLE_MS\) return;/);
  assert.match(source, /await performReload\(ctx\)/);
  assert.match(source, /await reloadWhenIdle\(ctx\)/);
});

test("long-running turns receive one persisted managed preemption before forced reload", () => {
  assert.match(source, /FORCE_RELOAD_AFTER_MS = 30_000/);
  assert.match(source, /AUTO_RELOAD_ACTIVITY_REQUEST_EVENT/);
  assert.match(source, /AUTO_RELOAD_PREEMPT_EVENT/);
  assert.match(source, /managedReloadDecision/);
  assert.match(source, /idle: ctx\.isIdle\(\) && !managedWorkActive/);
  assert.match(source, /ctx\.abort\(\)/);
  assert.match(source, /preemptRequested = true/);
  assert.match(
    source,
    /appendEntry\(RELOAD_RESUME_ENTRY[\s\S]*?status: "pending"[\s\S]*?ctx\.abort\(\)/,
  );
});

test("bounded reload resumes the interrupted generation before preserved queues", () => {
  assert.doesNotMatch(source, /pendingMessages: ctx\.hasPendingMessages\(\)/);
  assert.doesNotMatch(
    source,
    /agent_end[\s\S]*?if \(ctx\.hasPendingMessages\(\)\) return/,
  );
  assert.doesNotMatch(source, /resumeAfterPending/);
  assert.match(source, /deliverAs: "resume"/);
  assert.match(source, /status: "resumed"/);
});

test("managed source events start settle-gated reload immediately instead of waiting on a fixed debounce", () => {
  assert.match(source, /queueMicrotask\(\(\) => void reloadWhenIdle\(ctx\)\)/);
  assert.doesNotMatch(source, /DEBOUNCE_MS/);
});

test("automatic reload waits for sources to settle, never for a clean working tree", () => {
  assert.match(source, /SETTLE_MS = 15_000/);
  assert.match(source, /settled: now - lastChangeAt >= SETTLE_MS/);
  assert.match(source, /reload:awaiting-settle/);
  assert.doesNotMatch(
    source,
    /managedSourcesAreCommitted/,
    "the git commit gate never opens under the worktree flow where the main checkout stays dirty",
  );
  assert.doesNotMatch(source, /git.*diff/);
});

test("per-process managed generation detects nested in-place changes missed by directory mtimes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-reload-"));
  try {
    const nested = join(root, "extensions", "sample.ts");
    mkdirSync(join(root, "extensions"));
    writeFileSync(nested, "export const value = 1;\n");
    const first = managedGeneration([root]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(nested, "export const value = 2;\n");
    const second = managedGeneration([root]);
    assert.notEqual(second, first);
    assert.equal(managedGeneration([root]), second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
