import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedGeneration, managedSourcesAreCommitted } from "./index.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("pending managed reload executes as soon as the agent fully settles", () => {
  assert.match(source, /pi\.on\("agent_settled"/);
  assert.match(source, /if \(!pending \|\| !isReloadableContext\(ctx\)\) return;/);
  assert.match(source, /await reloadWhenIdle\(ctx\)/);
});

test("managed source events start commit-gated reload immediately instead of waiting on a fixed debounce", () => {
  assert.match(source, /queueMicrotask\(\(\) => void reloadWhenIdle\(ctx\)\)/);
  assert.doesNotMatch(source, /DEBOUNCE_MS/);
});

test("automatic reload waits until managed tracked sources are committed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-reload-git-"));
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { stdio: "ignore" });
  try {
    mkdirSync(join(root, "ai"));
    writeFileSync(join(root, "ai", "AGENTS.md"), "initial\n");
    assert.equal(git("init").status, 0);
    assert.equal(git("add", "ai/AGENTS.md").status, 0);
    assert.equal(git("-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "initial").status, 0);
    assert.equal(managedSourcesAreCommitted(root), true);
    writeFileSync(join(root, "ai", "AGENTS.md"), "intermediate\n");
    assert.equal(managedSourcesAreCommitted(root), false);
    assert.equal(git("add", "ai/AGENTS.md").status, 0);
    assert.equal(managedSourcesAreCommitted(root), false);
    assert.equal(git("-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "validated").status, 0);
    assert.equal(managedSourcesAreCommitted(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
