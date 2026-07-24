import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../pi/extensions/package.json", import.meta.url), "utf8"));
const extensions: unknown = manifest.pi?.extensions;

test("managed Pi package loads coordination extensions in normal sessions", () => {
  assert.ok(Array.isArray(extensions));
  assert.equal(extensions.includes("./activity-status/index.ts"), true);
  assert.equal(extensions.includes("./agent-registry/index.ts"), true);
  assert.equal(extensions.includes("./btw/index.ts"), true);
  assert.equal(extensions.includes("./questions/index.ts"), true);
  assert.equal(extensions.includes("./safe-compaction/index.ts"), true);
  assert.equal(extensions.includes("./classified-workflows/index.ts"), false);
});
