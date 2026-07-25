import assert from "node:assert/strict";
import test from "node:test";

import { currentReadDisprovesDuplicateBlock } from "./stale-duplicate.ts";

const call = (id: string, name: string, args: unknown) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});

const result = (id: string, text: string, isError = false) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    isError,
    content: [{ type: "text", text }],
  },
});

const edit = {
  path: "crates/yielduck/tests/exit.rs",
  edits: [{
    oldText: "tokio::select! {\n    branch",
    newText: "let ordering = tokio::select! {\n    branch",
  }],
};

test("a current successful read disproves a duplicate-only edit block", () => {
  const branch = [
    call("read-1", "read", { path: edit.path, offset: 510, limit: 20 }),
    result("read-1", `before\n${edit.edits[0]?.oldText}\nafter`),
  ];

  assert.equal(currentReadDisprovesDuplicateBlock({
    reason: "The requested edit is already present, so this would duplicate the mutation.",
    edit,
    branch,
    cwd: "/repo",
  }), true);
});

test("an error read, missing anchor, or independent policy block cannot override", () => {
  const matchingCall = call("read-1", "read", { path: edit.path });
  const cases = [
    {
      reason: "The requested edit is already present.",
      branch: [matchingCall, result("read-1", edit.edits[0]?.oldText ?? "", true)],
    },
    {
      reason: "The requested edit is already present.",
      branch: [matchingCall, result("read-1", "different source")],
    },
    {
      reason: "The edit is already present and the target is unrelated and unauthorized.",
      branch: [matchingCall, result("read-1", edit.edits[0]?.oldText ?? "")],
    },
  ];

  for (const candidate of cases) {
    assert.equal(currentReadDisprovesDuplicateBlock({
      reason: candidate.reason,
      edit,
      branch: candidate.branch,
      cwd: "/repo",
    }), false);
  }
});

test("a successful later mutation makes the read stale", () => {
  const branch = [
    call("read-1", "read", { path: edit.path }),
    result("read-1", edit.edits[0]?.oldText ?? ""),
    call("edit-1", "edit", edit),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "edit-1",
        toolName: "edit",
        isError: false,
        content: [{ type: "text", text: "Updated" }],
      },
    },
  ];

  assert.equal(currentReadDisprovesDuplicateBlock({
    reason: "This exact edit was already applied.",
    edit,
    branch,
    cwd: "/repo",
  }), false);
});

test("proof is path-scoped and requires every replacement anchor", () => {
  const twoEdits = {
    ...edit,
    edits: [...edit.edits, { oldText: "second anchor", newText: "replacement" }],
  };
  const branch = [
    call("wrong", "read", { path: "other.rs" }),
    result("wrong", `${twoEdits.edits[0]?.oldText}\nsecond anchor`),
    call("partial", "read", { path: edit.path }),
    result("partial", twoEdits.edits[0]?.oldText ?? ""),
  ];

  assert.equal(currentReadDisprovesDuplicateBlock({
    reason: "Duplicate operation: content already implemented.",
    edit: twoEdits,
    branch,
    cwd: "/repo",
  }), false);
});
