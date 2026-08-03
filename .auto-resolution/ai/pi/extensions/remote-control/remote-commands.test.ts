import assert from "node:assert/strict";
import test from "node:test";

import { remoteKanbanResponse } from "./remote-commands.ts";

test("remote kanban renders the latest bounded todo snapshot without model tools", () => {
  const response = remoteKanbanResponse([
    {
      type: "custom",
      customType: "todo.state",
      data: {
        nextId: 4,
        todos: [
          { id: 1, text: "Ship Telegram", status: "in_progress" },
          { id: 2, text: "Review ST0x", status: "pending" },
          {
            id: 3,
            text: "Deploy",
            status: "blocked",
            reason: "Needs production access",
          },
        ],
      },
    },
  ]);

  assert.match(response, /ACTIVE \(2\)/);
  assert.match(response, /#1 Ship Telegram/);
  assert.match(response, /#2 Review ST0x/);
  assert.match(response, /BLOCKED \(1\)/);
  assert.match(response, /#3 Deploy — Needs production access/);
  assert.ok(response.length <= 4_000);
});
