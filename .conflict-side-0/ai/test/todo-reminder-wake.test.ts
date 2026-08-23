import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/todo/index.ts", import.meta.url), "utf8");

test("todo exposes optional timezone-qualified deferred reminder input", () => {
  assert.match(source, /remindAt: Type\.Optional\(\s*Type\.String/);
  assert.match(source, /only with status=deferred/);
  assert.match(source, /parseTodoAction\(params, Date\.now\(\)\)/);
});

test("due reminders restore on reload and wake only from an idle prompt-safe state", () => {
  assert.match(source, /nextDeferredReminderAt/);
  assert.match(source, /wakeDueDeferredTodos/);
  assert.match(source, /isContinuationPaused\(ctx\.sessionManager\.getBranch\(\)\)/);
  assert.match(source, /autoReloadPending\(\)/);
  assert.match(source, /!ctx\.isIdle\(\)[\s\S]*ctx\.hasPendingMessages\(\)/);
  assert.match(source, /Scheduled todo reminder due:/);
  assert.match(source, /triggerTurn: true, deliverAs: "followUp"/);
  assert.match(source, /pi\.on\("agent_settled"/);
});

test("reminder timers are bounded and cleared with session-scoped resources", () => {
  assert.match(source, /MAX_TIMER_DELAY_MS/);
  assert.match(source, /Math\.min\(Math\.max\(0, nextAt - Date\.now\(\)\), MAX_TIMER_DELAY_MS\)/);
  assert.match(source, /pi\.on\("session_shutdown"/);
  assert.match(source, /clearTimeout\(reminderTimer\)/);
});
