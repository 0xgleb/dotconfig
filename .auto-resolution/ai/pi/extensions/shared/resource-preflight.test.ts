import assert from "node:assert/strict"
import test from "node:test"

import {
  resourcePreflightBlockMessage,
  resourcePreflightDisprovesBlock,
  type ResourcePreflightSnapshot,
} from "./resource-preflight.ts"

const allowed: ResourcePreflightSnapshot = {
  verdict: "allow",
  diskAvailableBytes: String(90n * 1024n ** 3n),
  diskReserveBytes: String(32n * 1024n ** 3n),
  memoryAvailableBytes: String(16n * 1024n ** 3n),
  memoryReserveBytes: String(8n * 1024n ** 3n),
  checkedAt: Date.now(),
}

test("fresh authoritative capacity supersedes a stale missing-reserve-evidence block", () => {
  assert.equal(
    resourcePreflightDisprovesBlock(
      "No evidence shows the disk reserve was restored after cleanup",
      allowed,
    ),
    true,
  )
})

test("actual pressure blocks report exact capacity, shortfall, and bounded recovery", () => {
  const message = resourcePreflightBlockMessage({
    ...allowed,
    verdict: "block",
    reason: "disk pressure",
    diskAvailableBytes: String(20n * 1024n ** 3n),
  })
  assert.match(message ?? "", /20\.00 GiB available/)
  assert.match(message ?? "", /32\.00 GiB reserve/)
  assert.match(message ?? "", /12\.00 GiB shortfall/)
  assert.match(message ?? "", /standing exact cleanup authority/)
  assert.match(message ?? "", /dust or Nushell `du`/)
  assert.match(message ?? "", /continue the blocked gate/)
  assert.equal(resourcePreflightBlockMessage(allowed), undefined)
})

test("resource preflight never overrides semantic policy or an actual pressure block", () => {
  assert.equal(
    resourcePreflightDisprovesBlock(
      "The deployment is unauthorized and disk capacity is unclear",
      allowed,
    ),
    false,
  )
  assert.equal(
    resourcePreflightDisprovesBlock("This mutation is unrelated", allowed),
    false,
  )
  assert.equal(
    resourcePreflightDisprovesBlock(
      "No evidence shows the disk reserve was restored",
      {
        ...allowed,
        verdict: "block",
        reason: "disk pressure",
      },
    ),
    false,
  )
})
