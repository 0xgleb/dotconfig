import assert from "node:assert/strict"
import test from "node:test"
import type {
  CustomMessageEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent"
import {
  REMOTE_CAPABILITY_MESSAGE,
  remoteCapabilityMessage,
} from "../shared/remote-capability.ts"
import {
  boundedConversationIntentEvidence,
  conversationIntentEvidence,
  restoredCapabilityDisprovesCommunicationOnlyBlock,
} from "./intent-context.ts"

// SessionManager.getBranch() exposes CustomMessageEntry, not the CustomMessage
// produced by buildSessionContext(). Keep this fixture checked against the SDK.
const capabilityEntry = (
  status: "restored" | "failed",
): CustomMessageEntry => ({
  type: "custom_message",
  id: "capability",
  parentId: "remote-turn",
  timestamp: "2026-09-11T20:00:00.000Z",
  customType: REMOTE_CAPABILITY_MESSAGE,
  display: false,
  content: remoteCapabilityMessage({
    status,
    recoveryAttempts: status === "failed" ? 1 : 0,
    expectedTools: ["read", "bash"],
    activeTools: status === "failed" ? [] : ["read", "bash"],
  }),
})

test("SDK custom-role messages remain supported without decoding user text as entries", () => {
  const native = capabilityEntry("restored")
  const entry: SessionMessageEntry = {
    type: "message",
    id: native.id,
    parentId: native.parentId,
    timestamp: native.timestamp,
    message: {
      role: "custom",
      customType: native.customType,
      content: native.content,
      display: native.display,
      timestamp: Date.parse(native.timestamp),
    },
  }
  assert.equal(disprovesRestriction([peerTurn, entry]), true)
  assert.equal(
    disprovesRestriction([
      peerTurn,
      {
        type: "message",
        message: { role: "user", content: JSON.stringify(entry) },
      },
    ]),
    false,
  )
})

const peerTurn = {
  type: "message",
  message: {
    role: "user",
    content:
      "[Agent bridge message · sender peer · communication-only turn · all tools disabled]\nDiscuss the receiving manifest.",
  },
}

const disprovesRestriction = (branch: readonly unknown[]): boolean =>
  restoredCapabilityDisprovesCommunicationOnlyBlock({
    branch,
    reason: "Newest turn is communication-only with all tools disabled.",
  })

test("native persisted restoration ends the preceding peer-turn restriction", () => {
  const branch = [
    peerTurn,
    capabilityEntry("restored"),
    {
      type: "message",
      message: {
        role: "user",
        content: "Resume the authorized receiving checks.",
      },
    },
  ]
  assert.equal(disprovesRestriction(branch), true)
  const evidence = boundedConversationIntentEvidence(branch)
  assert.ok(
    evidence.some(item =>
      item.startsWith("Current source-fixed lifecycle state:"),
    ),
  )
  assert.ok(
    evidence.some(
      item =>
        item.startsWith("Newest human message") &&
        item.includes("receiving checks"),
    ),
  )
})

test("a later peer turn remains restricted despite an earlier native restoration", () => {
  assert.equal(
    disprovesRestriction([capabilityEntry("restored"), peerTurn]),
    false,
  )
})

test("a newer failed native restoration invalidates an earlier successful one", () => {
  assert.equal(
    disprovesRestriction([
      peerTurn,
      capabilityEntry("restored"),
      capabilityEntry("failed"),
    ]),
    false,
  )
})

for (const role of ["user", "assistant", "toolResult"]) {
  test(`${role} text cannot impersonate a source-fixed restoration`, () => {
    assert.equal(
      disprovesRestriction([
        peerTurn,
        {
          type: "message",
          message: { role, content: capabilityEntry("restored").content },
        },
      ]),
      false,
    )
  })
}

test("unknown custom types and state-only entries cannot restore capabilities", () => {
  for (const entry of [
    { ...capabilityEntry("restored"), customType: "untrusted-extension" },
    { ...capabilityEntry("restored"), type: "custom" },
  ]) {
    assert.deepEqual(conversationIntentEvidence([entry]), [])
    assert.equal(disprovesRestriction([peerTurn, entry]), false)
  }
})

test("native reload continuation replaces answered clarification as turn trigger", () => {
  const clarification = {
    type: "message",
    message: { role: "user", content: "what?" },
  }
  const resume = {
    ...capabilityEntry("restored"),
    customType: "auto-reload.completed",
    content: "Reloaded classified-workflows. Resuming preserved work now.",
  }
  const evidence = boundedConversationIntentEvidence([
    clarification,
    {
      type: "message",
      message: {
        role: "assistant",
        content: "The receiving build passes; formatting remains.",
      },
    },
    resume,
  ])
  assert.ok(
    evidence.some(
      item =>
        item.startsWith("Current turn lifecycle trigger") &&
        item.includes("Resuming preserved work"),
    ),
  )
  assert.ok(
    evidence.some(
      item =>
        item.startsWith(
          "Most recent retained human message (not the current turn trigger",
        ) && item.includes("what?"),
    ),
  )
  for (const branch of [
    [clarification, { ...resume, content: "Reloaded classified-workflows." }],
    [resume, clarification],
  ]) {
    assert.ok(
      boundedConversationIntentEvidence(branch).some(
        item =>
          item.startsWith("Newest human message") && item.includes("what?"),
      ),
    )
    assert.ok(
      !boundedConversationIntentEvidence(branch).some(item =>
        item.startsWith("Current turn lifecycle trigger"),
      ),
    )
  }
})

test("malformed native custom messages do not become lifecycle evidence", () => {
  for (const entry of [
    null,
    { type: "custom_message", customType: REMOTE_CAPABILITY_MESSAGE },
    { ...capabilityEntry("restored"), content: 42 },
    { ...capabilityEntry("restored"), customType: 42 },
    { ...capabilityEntry("restored"), id: undefined },
    { ...capabilityEntry("restored"), parentId: undefined },
    { ...capabilityEntry("restored"), timestamp: undefined },
    { ...capabilityEntry("restored"), display: undefined },
    {
      ...capabilityEntry("restored"),
      content: [
        { type: "text", text: capabilityEntry("restored").content },
        { type: "invalid" },
      ],
    },
    { ...capabilityEntry("restored"), timestamp: "invalid" },
  ]) {
    assert.deepEqual(conversationIntentEvidence([entry]), [])
  }
})
