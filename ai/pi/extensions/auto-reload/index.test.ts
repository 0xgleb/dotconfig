import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { managedExtensionSet, managedGeneration } from "./index.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("pending managed reload executes at agent end before continuous follow-ups can starve idle", () => {
  const agentEnd = source.indexOf('pi.on("agent_end"');
  const agentSettled = source.indexOf('pi.on("agent_settled"');
  assert.ok(agentEnd > 0);
  assert.ok(agentEnd < agentSettled);
  assert.match(source, /if \(!pending \|\| !isReloadableContext\(ctx\)\) return;/);
  assert.match(source, /if \(readManagedSources\(Date\.now\(\)\) !== "settled"\) return;/);
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
  assert.match(source, /const source = readManagedSources\(now\)/);
  assert.match(source, /reload:awaiting-settle/);
  assert.match(source, /reload:awaiting-coherence/);
  assert.doesNotMatch(
    source,
    /managedSourcesAreCommitted/,
    "the git commit gate never opens under the worktree flow where the main checkout stays dirty",
  );
  assert.doesNotMatch(source, /git.*diff/);
});

test("a tree the coherence gate holds names the module it could not resolve", () => {
  assert.match(source, /COHERENCE_NOTICE_AFTER_MS = 4 \* FORCE_RELOAD_AFTER_MS/);
  assert.match(source, /coherenceDiagnostic\(\{/);
  assert.match(source, /coherenceAnnounced = true/);
  assert.match(
    source,
    /ctx\.ui\.notify\(\s*`Automatic Pi reload is held[\s\S]*?\$\{unresolvedManaged/,
  );
  assert.match(
    source,
    /if \(source !== "incoherent"\) coherenceAnnounced = false;/,
    "a tree that recovers must be able to report the next stretch of incoherence",
  );
});

test("a settled tree is only reloaded once the extension set it declares resolves", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-set-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ pi: { extensions: ["./sample/index.ts"] } }),
    );
    assert.deepEqual(
      managedExtensionSet(root),
      {
        resolution: "incomplete",
        unresolved: join(root, "sample", "index.ts"),
      },
      "a declared entrypoint that is not on disk yet is a change set still landing, and the operator is owed its name",
    );

    mkdirSync(join(root, "sample"));
    writeFileSync(
      join(root, "sample", "index.ts"),
      'import { lane } from "../shared/lane.ts";\nexport default lane;\n',
    );
    assert.deepEqual(
      managedExtensionSet(root),
      {
        resolution: "incomplete",
        unresolved: `../shared/lane.ts imported by ${join(root, "sample", "index.ts")}`,
      },
      "a consumer written before the module it imports would throw on import",
    );

    mkdirSync(join(root, "shared"));
    writeFileSync(join(root, "shared", "lane.ts"), "export const lane = 1;\n");
    assert.deepEqual(managedExtensionSet(root), { resolution: "complete" });

    rmSync(join(root, "package.json"));
    assert.deepEqual(
      managedExtensionSet(root),
      {
        resolution: "incomplete",
        unresolved: join(root, "package.json"),
      },
      "an unreadable manifest declares nothing worth loading",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the extension set resolves every module shape the managed tree may hold", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-shapes-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ pi: { extensions: ["./sample/index.ts"] } }),
    );
    mkdirSync(join(root, "sample"));
    writeFileSync(
      join(root, "sample", "index.ts"),
      'import { Panel } from "./panel";\nimport { theme } from "../widgets";\nexport default { Panel, theme };\n',
    );
    writeFileSync(
      join(root, "sample", "panel.tsx"),
      "export const Panel = () => null;\n",
    );
    mkdirSync(join(root, "widgets"));
    writeFileSync(
      join(root, "widgets", "index.tsx"),
      "export const theme = 1;\n",
    );
    assert.deepEqual(
      managedExtensionSet(root),
      { resolution: "complete" },
      "a .tsx module and a directory whose entry is index.tsx are both managed modules, so neither may read as a half-written tree",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the managed extension set this session runs is complete", () => {
  assert.deepEqual(
    managedExtensionSet(fileURLToPath(new URL("..", import.meta.url))),
    { resolution: "complete" },
    "the coherence gate must pass on the tree it ships with, or it would wedge every reload",
  );
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
