import assert from "node:assert/strict";
import test from "node:test";
import { activeSkillProcedures } from "./skill-context.ts";

const skillExchange = (path: string, content: string) => [
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-skill", name: "read", arguments: { path } }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "read-skill",
      toolName: "read",
      content: [{ type: "text", text: content }],
    },
  },
];

test("verified local skill reads become bounded active procedure context", () => {
  const procedures = activeSkillProcedures(
    skillExchange(
      "/Users/example/.agents/skills/review-core/SKILL.md",
      'Run cursor-agent -p --mode plan --model composer-2.5 --trust "Reply with exactly: OK"',
    ),
    {
      home: "/Users/example",
      cwd: "/repo",
      readSkillFile: () => 'Run cursor-agent -p --mode plan --model composer-2.5 --trust "Reply with exactly: OK"',
    },
  );

  assert.equal(procedures.length, 1);
  assert.match(procedures[0] ?? "", /Active skill review-core/);
  assert.match(procedures[0] ?? "", /cursor-agent -p --mode plan/);
});

test("active skill context retains the bounded human topic that invoked it", () => {
  const procedures = activeSkillProcedures(
    [
      {
        type: "message",
        message: {
          role: "user",
          content:
            "Shape future options-market evidence and short-side scope only.",
        },
      },
      ...skillExchange(
        "/Users/example/.agents/skills/shape-work/SKILL.md",
        "Do not modify implementation plans while shaping this feature.",
      ),
    ],
    {
      home: "/Users/example",
      cwd: "/repo",
      readSkillFile: () =>
        "Do not modify implementation plans while shaping this feature.",
    },
  );

  assert.match(procedures[0] ?? "", /Invocation topic.*future options-market evidence/);
  assert.match(procedures[0] ?? "", /scopes this procedure/);
});

test("reload resolves an observed active skill from its current trusted source", () => {
  const procedures = activeSkillProcedures(
    skillExchange("/Users/example/.agents/skills/eod/SKILL.md", "Stale procedure: always use Edit"),
    {
      home: "/Users/example",
      cwd: "/repo",
      readSkillFile: () => "Current procedure: use Write for a verified zero-byte target",
    },
  );

  assert.match(procedures[0] ?? "", /Current procedure: use Write/);
  assert.doesNotMatch(procedures[0] ?? "", /Stale procedure/);
});

test("unpaired, non-skill, and untrusted skill-like results are excluded", () => {
  const branch = [
    ...skillExchange("/repo/README.md", "cursor-agent --yolo"),
    ...skillExchange("/tmp/skills/review-core/SKILL.md", "cursor-agent --yolo"),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "missing-call",
        toolName: "read",
        content: [{ type: "text", text: "cursor-agent --yolo" }],
      },
    },
  ];
  assert.deepEqual(activeSkillProcedures(branch, { home: "/Users/example", cwd: "/repo" }), []);
});
