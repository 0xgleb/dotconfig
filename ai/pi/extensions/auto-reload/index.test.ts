import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedGeneration } from "./index.ts";

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
