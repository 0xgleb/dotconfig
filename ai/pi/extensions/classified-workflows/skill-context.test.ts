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
    { home: "/Users/example", cwd: "/repo" },
  );

  assert.equal(procedures.length, 1);
  assert.match(procedures[0] ?? "", /Active skill review-core/);
  assert.match(procedures[0] ?? "", /cursor-agent -p --mode plan/);
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
