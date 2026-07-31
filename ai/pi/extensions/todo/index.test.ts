import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { KANBAN_OVERLAY_OPTIONS, KanbanComponent } from "./kanban.ts";
import type { TodoState } from "./state.ts";

const state: TodoState = {
  nextId: 5,
  todos: [
    { id: 1, text: "Finished", status: "completed" },
    { id: 2, text: "Working", status: "in_progress" },
    { id: 3, text: "Queued", status: "pending" },
    { id: 4, text: "Blocked", status: "blocked", reason: "Waiting" },
  ],
};

test("kanban overlay is centered within the current Pi pane", () => {
  assert.deepEqual(KANBAN_OVERLAY_OPTIONS, {
    anchor: "center",
    width: "72%",
    minWidth: 64,
    maxHeight: "80%",
    margin: 2,
  });
});

test("kanban renders a glass-backed frame in NEXT to NOW to DONE order", () => {
  let backgroundCalls = 0;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => {
      backgroundCalls += 1;
      return text;
    },
    bold: (text: string) => text,
  } as unknown as Theme;
  const lines = new KanbanComponent(state, theme, () => {}).render(90);
  const headings = lines.find((line) => line.includes("NEXT") && line.includes("NOW") && line.includes("DONE"));

  assert.ok(headings);
  assert.ok(headings.indexOf("NEXT") < headings.indexOf("NOW"));
  assert.ok(headings.indexOf("NOW") < headings.indexOf("DONE"));
  assert.match(lines[0] ?? "", /^╭.*KANBAN.*╮$/);
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
  assert.ok(backgroundCalls >= lines.length - 2);
  for (const line of lines) assert.equal(visibleWidth(line), 90);
});
