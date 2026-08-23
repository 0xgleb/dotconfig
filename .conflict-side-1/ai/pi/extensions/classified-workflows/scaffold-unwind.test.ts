import assert from "node:assert/strict"
import test from "node:test"

import { exactScaffoldUnwindDisprovesBlock } from "./scaffold-unwind.ts"

const call = (id: string, name: string, args: unknown) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
})

const result = (id: string, isError = false, text?: string) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    isError,
    content: [
      {
        type: "text",
        text: text ?? (isError ? "failed" : "updated"),
      },
    ],
  },
})

const user = (text: string) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
})

const forward = {
  path: "tests/adr43.e2e.ts",
  edits: [
    {
      oldText: "existing test\n",
      newText: "existing test\nnew failing ADR43 test\n",
    },
  ],
}
const inverse = {
  path: forward.path,
  edits: [
    { oldText: forward.edits[0]?.newText, newText: forward.edits[0]?.oldText },
  ],
}

const branch = [
  call("edit-1", "edit", forward),
  result("edit-1"),
  user("Defer ADR43 and focus on the Telegram hotfix instead."),
]

test("exact inverse of agent-added scaffolding is allowed after owner reprioritization", () => {
  assert.equal(
    exactScaffoldUnwindDisprovesBlock({
      reason:
        "Removing this failing test would weaken the required TTDD workflow.",
      edit: inverse,
      branch,
      cwd: "/repo",
    }),
    true,
  )
})

test("newly written uncommitted scaffolding can be emptied after its lane is deferred", () => {
  const content = "test('ADR43', () => assert.fail());\n"
  assert.equal(
    exactScaffoldUnwindDisprovesBlock({
      reason: "Deleting the test would weaken verification.",
      edit: {
        path: "tests/new-adr43.e2e.ts",
        edits: [{ oldText: content, newText: "" }],
      },
      branch: [
        call("write-1", "write", { path: "tests/new-adr43.e2e.ts", content }),
        result("write-1"),
        user("This slice is deferred; work on PT looping first."),
      ],
      cwd: "/repo",
    }),
    true,
  )
})

test("spec-only scaffolding can unwind after its implementation is pre-execution blocked", () => {
  const specForward = {
    path: "SPEC.md",
    edits: [
      {
        oldText: "NAV updates are event driven.\n",
        newText: "NAV updates are event driven with a 30 second timeout.\n",
      },
    ],
  }
  const specInverse = {
    path: specForward.path,
    edits: [
      {
        oldText: specForward.edits[0]?.newText,
        newText: specForward.edits[0]?.oldText,
      },
    ],
  }
  const implementation = {
    path: "src/nav.rs",
    edits: [{ oldText: "poll_nav();", newText: "poll_nav_with_timeout();" }],
  }

  assert.equal(
    exactScaffoldUnwindDisprovesBlock({
      reason:
        "Removing the timeout sentence would weaken the spec after implementation edits.",
      edit: specInverse,
      branch: [
        call("spec-edit", "edit", specForward),
        result("spec-edit"),
        call("implementation-edit", "edit", implementation),
        result(
          "implementation-edit",
          true,
          "Auto-classifier verdict: Implementation requires a failing top-level e2e test before source changes.",
        ),
      ],
      cwd: "/repo",
    }),
    true,
  )
})

test("blocked-implementation unwind preserves established specs and successful implementation", () => {
  const specForward = {
    path: "SPEC.md",
    edits: [{ oldText: "old\n", newText: "old\ntimeout requirement\n" }],
  }
  const specInverse = {
    path: specForward.path,
    edits: [
      {
        oldText: specForward.edits[0]?.newText,
        newText: specForward.edits[0]?.oldText,
      },
    ],
  }
  const implementation = {
    path: "src/nav.rs",
    edits: [{ oldText: "old", newText: "implemented" }],
  }
  const blocked = result(
    "implementation-edit",
    true,
    "Auto-classifier verdict: Add a failing e2e test before implementation.",
  )
  const cases = [
    [call("implementation-edit", "edit", implementation), blocked],
    [
      call("spec-edit", "edit", specForward),
      result("spec-edit"),
      call("implementation-edit", "edit", implementation),
      result("implementation-edit"),
    ],
    [
      call("spec-edit", "edit", specForward),
      result("spec-edit"),
      call("implementation-edit", "edit", implementation),
      result("implementation-edit", true, "compiler failed after execution"),
    ],
  ]
  for (const candidate of cases) {
    assert.equal(
      exactScaffoldUnwindDisprovesBlock({
        reason: "Removing the timeout requirement would weaken the spec.",
        edit: specInverse,
        branch: candidate,
        cwd: "/repo",
      }),
      false,
    )
  }
})

test("unwind remains blocked without an exact successful inverse and later human reprioritization", () => {
  const cases = [
    { branch: branch.slice(0, 2), edit: inverse },
    {
      branch: [
        call("edit-1", "edit", forward),
        result("edit-1", true),
        user("Defer ADR43"),
      ],
      edit: inverse,
    },
    {
      branch,
      edit: {
        ...inverse,
        edits: [
          { oldText: inverse.edits[0]?.oldText, newText: "different content" },
        ],
      },
    },
  ]
  for (const candidate of cases) {
    assert.equal(
      exactScaffoldUnwindDisprovesBlock({
        reason: "Removing this failing test would weaken TTDD.",
        edit: candidate.edit,
        branch: candidate.branch,
        cwd: "/repo",
      }),
      false,
    )
  }
})

test("independent committed or user-owned test concerns never get overridden", () => {
  for (const reason of [
    "Removing this committed test would weaken TTDD.",
    "Deleting this existing user test weakens verification.",
    "The unrelated test removal is unauthorized.",
  ]) {
    assert.equal(
      exactScaffoldUnwindDisprovesBlock({
        reason,
        edit: inverse,
        branch,
        cwd: "/repo",
      }),
      false,
    )
  }
})
