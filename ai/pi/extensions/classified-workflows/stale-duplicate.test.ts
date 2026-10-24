import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  currentMissingBuildOutputDisprovesDuplicateBlock,
  currentReadDisprovesDuplicateBlock,
} from "./stale-duplicate.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const call = (id: string, name: string, args: unknown) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
})

const result = (id: string, text: string, isError = false) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    isError,
    content: [{ type: "text", text }],
  },
})

const edit = {
  path: "crates/yielduck/tests/exit.rs",
  edits: [
    {
      oldText: "tokio::select! {\n    branch",
      newText: "let ordering = tokio::select! {\n    branch",
    },
  ],
}

test("a current successful read disproves a duplicate-only edit block", () => {
  const branch = [
    call("read-1", "read", { path: edit.path, offset: 510, limit: 20 }),
    result("read-1", `before\n${edit.edits[0]?.oldText}\nafter`),
  ]

  assert.equal(
    currentReadDisprovesDuplicateBlock({
      reason:
        "The requested edit is already present, so this would duplicate the mutation.",
      edit,
      branch,
      cwd: "/repo",
    }),
    true,
  )
})

test("an error read, missing anchor, or independent policy block cannot override", () => {
  const matchingCall = call("read-1", "read", { path: edit.path })
  const cases = [
    {
      reason: "The requested edit is already present.",
      branch: [
        matchingCall,
        result("read-1", edit.edits[0]?.oldText ?? "", true),
      ],
    },
    {
      reason: "The requested edit is already present.",
      branch: [matchingCall, result("read-1", "different source")],
    },
    {
      reason:
        "The edit is already present and the target is unrelated and unauthorized.",
      branch: [matchingCall, result("read-1", edit.edits[0]?.oldText ?? "")],
    },
  ]

  for (const candidate of cases) {
    assert.equal(
      currentReadDisprovesDuplicateBlock({
        reason: candidate.reason,
        edit,
        branch: candidate.branch,
        cwd: "/repo",
      }),
      false,
    )
  }
})

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
  ]

  assert.equal(
    currentReadDisprovesDuplicateBlock({
      reason: "This exact edit was already applied.",
      edit,
      branch,
      cwd: "/repo",
    }),
    false,
  )
})

test("a newer missing Nix output disproves stale identical build success", () => {
  const command = "nix build --no-link .#checks.aarch64-darwin.default"
  const branch = [
    call("build-1", "bash", { command }),
    result("build-1", "build completed"),
    call("path-info", "bash", {
      command: "nix path-info /nix/store/dxs95-fj-infra-lib-test",
    }),
    result(
      "path-info",
      "error: path '/nix/store/dxs95-fj-infra-lib-test' is not valid",
      true,
    ),
  ]

  assert.match(
    extensionSource,
    /event\.toolName === "bash"[\s\S]*?currentMissingBuildOutputDisprovesDuplicateBlock/,
  )
  assert.equal(
    currentMissingBuildOutputDisprovesDuplicateBlock({
      reason:
        "This exact command already succeeded with the same input digest.",
      bash: { command },
      branch,
    }),
    true,
  )
})

test("build duplicate override preserves independent blocks and current outputs", () => {
  const command = "nix build --no-link .#checks.aarch64-darwin.default"
  const successfulBuild = [
    call("build-1", "bash", { command }),
    result("build-1", "build completed"),
  ]
  const cases = [
    {
      reason:
        "The command already succeeded but is unrelated and unauthorized.",
      branch: [
        ...successfulBuild,
        call("path-info", "bash", { command: "nix path-info /nix/store/new" }),
        result("path-info", "error: path is not valid", true),
      ],
    },
    {
      reason: "The exact command already succeeded.",
      branch: [
        ...successfulBuild,
        call("path-info", "bash", { command: "nix path-info /nix/store/new" }),
        result("path-info", "/nix/store/new"),
      ],
    },
    {
      reason: "The exact command already succeeded.",
      branch: successfulBuild,
    },
  ]
  for (const candidate of cases) {
    assert.equal(
      currentMissingBuildOutputDisprovesDuplicateBlock({
        reason: candidate.reason,
        bash: { command },
        branch: candidate.branch,
      }),
      false,
    )
  }
})

test("proof is path-scoped and requires every replacement anchor", () => {
  const twoEdits = {
    ...edit,
    edits: [
      ...edit.edits,
      { oldText: "second anchor", newText: "replacement" },
    ],
  }
  const branch = [
    call("wrong", "read", { path: "other.rs" }),
    result("wrong", `${twoEdits.edits[0]?.oldText}\nsecond anchor`),
    call("partial", "read", { path: edit.path }),
    result("partial", twoEdits.edits[0]?.oldText ?? ""),
  ]

  assert.equal(
    currentReadDisprovesDuplicateBlock({
      reason: "Duplicate operation: content already implemented.",
      edit: twoEdits,
      branch,
      cwd: "/repo",
    }),
    false,
  )
})
