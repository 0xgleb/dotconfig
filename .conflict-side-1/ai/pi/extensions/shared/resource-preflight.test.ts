import assert from "node:assert/strict";
import test from "node:test";

import { resourcePreflightDisprovesBlock, type ResourcePreflightSnapshot } from "./resource-preflight.ts";

const allowed: ResourcePreflightSnapshot = {
  verdict: "allow",
  diskAvailableBytes: String(90n * 1024n ** 3n),
  diskReserveBytes: String(32n * 1024n ** 3n),
  memoryAvailableBytes: String(16n * 1024n ** 3n),
  memoryReserveBytes: String(8n * 1024n ** 3n),
  checkedAt: Date.now(),
};

test("fresh authoritative capacity supersedes a stale missing-reserve-evidence block", () => {
  assert.equal(
    resourcePreflightDisprovesBlock("No evidence shows the disk reserve was restored after cleanup", allowed),
    true,
  );
});

test("resource preflight never overrides semantic policy or an actual pressure block", () => {
  assert.equal(resourcePreflightDisprovesBlock("The deployment is unauthorized and disk capacity is unclear", allowed), false);
  assert.equal(resourcePreflightDisprovesBlock("This mutation is unrelated", allowed), false);
  assert.equal(
    resourcePreflightDisprovesBlock("No evidence shows the disk reserve was restored", {
      ...allowed,
      verdict: "block",
      reason: "disk pressure",
    }),
    false,
  );
});
