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

test("kanban reapplies its glass background after nested foreground resets", () => {
  const backgroundPrefix = "\x1b[48;2;24;20;58m";
  const backgroundSuffix = "\x1b[49m";
  const theme = {
    fg: (_color: string, text: string) => `\x1b[38;2;232;246;255m${text}\x1b[0m`,
    bg: (_color: string, text: string) => `${backgroundPrefix}${text}${backgroundSuffix}`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  } as unknown as Theme;
  const lines = new KanbanComponent(state, theme, () => {}).render(90);

  for (const line of lines.slice(1, -1)) {
    const backgroundStart = line.indexOf(backgroundPrefix);
    const backgroundEnd = line.lastIndexOf(backgroundSuffix);
    assert.ok(backgroundStart >= 0, "every interior row starts the glass background");
    assert.ok(backgroundEnd > backgroundStart, "every interior row closes the glass background");
    const interior = line.slice(backgroundStart + backgroundPrefix.length, backgroundEnd);
    assert.doesNotMatch(interior, /\x1b\[0m(?!\x1b\[48;2;24;20;58m)/);
    assert.equal(visibleWidth(line), 90);
  }
});
