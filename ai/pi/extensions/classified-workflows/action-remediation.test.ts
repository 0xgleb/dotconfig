import assert from "node:assert/strict"
import test from "node:test"
import {
  ACTION_REMEDIATION_ENTRY,
  remediationContinuationMessage,
  remediationForDecision,
  remediationInterruption,
  reconcileActionRemediation,
  resolvedActionRemediation,
  restorePendingActionRemediation,
} from "./action-remediation.ts"

const requestedAt = 1_777_500_000_000

test("an unverified explicitly requested EOD delivery becomes required work", () => {
  const remediation = remediationForDecision(
    "deliver_stakeholder_update",
    {
      verdict: "remediate",
      reason:
        "Telegram delivery is explicitly authorized, but the draft contains disputed and insufficiently verified status/count claims",
      source: "classifier",
    },
    requestedAt,
  )

  assert.deepEqual(remediation, {
    status: "pending",
    toolName: "deliver_stakeholder_update",
    reason:
      "Telegram delivery is explicitly authorized, but the draft contains disputed and insufficiently verified status/count claims",
    requestedAt,
  })
  assert.deepEqual(remediation && remediationInterruption(remediation), {
    block: true,
    reason:
      "Delivery verification required: Telegram delivery is explicitly authorized, but the draft contains disputed and insufficiently verified status/count claims. This is unfinished work, not a denial of the explicit delivery request.",
    remediation,
  })
  assert.match(
    remediation ? remediationContinuationMessage(remediation) : "",
    /verify the missing facts, correct the draft, and retry deliver_stakeholder_update/i,
  )
  assert.match(
    remediation ? remediationContinuationMessage(remediation) : "",
    /if verification genuinely cannot be completed, report the exact blocker to the \.config agent/i,
  )
  assert.match(
    remediation ? remediationContinuationMessage(remediation) : "",
    /do not stop or wait silently/i,
  )
})

test("remediation never converts an allow or hard policy block", () => {
  assert.equal(
    remediationForDecision(
      "deliver_stakeholder_update",
      { verdict: "allow", reason: "verified", source: "classifier" },
      requestedAt,
    ),
    undefined,
  )
  assert.equal(
    remediationForDecision(
      "deliver_stakeholder_update",
      {
        verdict: "block",
        reason: "No human authorized external delivery",
        source: "classifier",
      },
      requestedAt,
    ),
    undefined,
  )
})

test("pending delivery verification survives reconstruction until matching success", () => {
  const pending = {
    status: "pending" as const,
    toolName: "deliver_stakeholder_update",
    reason: "Verify disputed PR counts",
    requestedAt,
  }
  assert.deepEqual(
    restorePendingActionRemediation([
      {
        type: "custom",
        customType: ACTION_REMEDIATION_ENTRY,
        data: pending,
      },
    ]),
    pending,
  )
  assert.equal(
    restorePendingActionRemediation([
      {
        type: "custom",
        customType: ACTION_REMEDIATION_ENTRY,
        data: pending,
      },
      {
        type: "custom",
        customType: ACTION_REMEDIATION_ENTRY,
        data: resolvedActionRemediation(
          "deliver_stakeholder_update",
          requestedAt + 1,
        ),
      },
    ]),
    undefined,
  )
})

test("malformed trailing remediation state cannot erase valid pending work", () => {
  const pending = {
    status: "pending" as const,
    toolName: "deliver_stakeholder_update",
    reason: "Verify disputed PR counts",
    requestedAt,
  }
  assert.deepEqual(
    restorePendingActionRemediation([
      {
        type: "custom",
        customType: ACTION_REMEDIATION_ENTRY,
        data: pending,
      },
      {
        type: "custom",
        customType: ACTION_REMEDIATION_ENTRY,
        data: { status: "pending", reason: "missing tool identity" },
      },
    ]),
    pending,
  )
})

test("only a successful matching action resolves pending remediation", () => {
  const pending = {
    status: "pending" as const,
    toolName: "deliver_stakeholder_update",
    reason: "Verify disputed PR counts",
    requestedAt,
  }
  assert.equal(
    reconcileActionRemediation(pending, {
      toolName: "report_owner",
      outcome: "succeeded",
      finishedAt: requestedAt + 1,
    }),
    undefined,
  )
  assert.equal(
    reconcileActionRemediation(pending, {
      toolName: "deliver_stakeholder_update",
      outcome: "failed",
      finishedAt: requestedAt + 2,
    }),
    undefined,
  )
  assert.deepEqual(
    reconcileActionRemediation(pending, {
      toolName: "deliver_stakeholder_update",
      outcome: "succeeded",
      finishedAt: requestedAt + 3,
    }),
    resolvedActionRemediation("deliver_stakeholder_update", requestedAt + 3),
  )
})
