import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CRITICAL_FREE_BYTES,
  CRITICAL_FREE_MEMORY_BYTES,
  cleanupNewResultSymlinks,
  cleanupStalePiTempLogs,
  diskPressureDecision,
  isExpensiveCommand,
  isStalePiTempLog,
  resourcePressureDecision,
  resultSymlinkNames,
} from "./core.ts";

test("expensive build commands are blocked before consuming the crash reserve", () => {
  assert.equal(isExpensiveCommand("darwin-rebuild build --flake ."), true);
  assert.equal(isExpensiveCommand("nix build .#darwinConfigurations.host.system"), true);
  assert.equal(isExpensiveCommand("cargo nextest run"), true);
  assert.equal(isExpensiveCommand("git status"), false);
  assert.deepEqual(diskPressureDecision("nix build .", CRITICAL_FREE_BYTES - 1n), {
    verdict: "block",
    reason: "disk pressure",
  });
  assert.deepEqual(diskPressureDecision("git status", 1n), { verdict: "allow" });
});

test("expensive builds fail closed before consuming the memory crash reserve", () => {
  assert.deepEqual(
    resourcePressureDecision("cargo test --workspace", CRITICAL_FREE_BYTES, CRITICAL_FREE_MEMORY_BYTES - 1n),
    { verdict: "block", reason: "memory pressure" },
  );
  assert.deepEqual(resourcePressureDecision("git status", 1n, 1n), { verdict: "allow" });
});

test("temp cleanup accepts only old exact Pi log files directly under the temp root", () => {
  const now = Date.now();
  assert.equal(isStalePiTempLog("/tmp/pi-bash-deadbeef.log", "/tmp", now - 86_400_001, now), true);
  assert.equal(isStalePiTempLog("/tmp/pi-bash-deadbeef.log", "/tmp", now - 1_000, now), false);
  assert.equal(isStalePiTempLog("/tmp/nested/pi-bash-deadbeef.log", "/tmp", now - 90_000_000, now), false);
  assert.equal(isStalePiTempLog("/tmp/pi-bash-deadbeef.log/other", "/tmp", now - 90_000_000, now), false);
  assert.equal(isStalePiTempLog("/tmp/pi-other-deadbeef.log", "/tmp", now - 90_000_000, now), false);
});

test("temp cleanup removes only stale matching files and never traverses nested paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-disk-pressure-logs-"));
  const stale = join(root, "pi-bash-deadbeef.log");
  const fresh = join(root, "pi-bash-cafebabe.log");
  const lookalike = join(root, "pi-other-deadbeef.log");
  const nested = join(root, "nested");
  writeFileSync(stale, "old");
  writeFileSync(fresh, "new");
  writeFileSync(lookalike, "keep");
  mkdirSync(nested);
  writeFileSync(join(nested, "pi-bash-deadbeef.log"), "keep");
  utimesSync(stale, new Date(0), new Date(0));

  assert.deepEqual(cleanupStalePiTempLogs(root, Date.now()), ["pi-bash-deadbeef.log"]);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(lookalike), true);
  assert.equal(existsSync(join(nested, "pi-bash-deadbeef.log")), true);
});

test("result cleanup unlinks only newly created direct symlinks without following targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-disk-pressure-test-"));
  const target = join(root, "target");
  mkdirSync(target);
  writeFileSync(join(target, "keep"), "safe");
  symlinkSync(target, join(root, "result"));
  const before = resultSymlinkNames(root);
  symlinkSync(target, join(root, "result-2"));
  symlinkSync(target, join(root, "unrelated"));
  writeFileSync(join(root, "result-3"), "not a symlink");

  assert.deepEqual(cleanupNewResultSymlinks(root, before), ["result-2"]);
  assert.deepEqual(resultSymlinkNames(root), new Set(["result"]));
});
