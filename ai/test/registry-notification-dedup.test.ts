import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/agent-registry/index.ts", import.meta.url), "utf8");

test("registry request notifications survive reload and compaction", () => {
  assert.match(source, /NOTIFIED_REQUESTS_ENTRY = "agent-registry\.notified-requests"/);
  assert.match(source, /restoreNotifiedRequests\(ctx\)/);
  assert.match(source, /notifiedRequests\.add\(fresh\.id\);?\s*persistNotifiedRequests\(\)/);
  assert.match(source, /pi\.on\("session_compact", \(\) => persistNotifiedRequests\(\)\)/);
});

test("notification epoch replays pre-trigger claimed backlog once after upgrade", () => {
  assert.match(source, /NOTIFICATION_EPOCH = 2/);
  assert.match(source, /entry\.data\.epoch !== NOTIFICATION_EPOCH/);
  assert.match(source, /epoch: NOTIFICATION_EPOCH,[\s\S]*ids:/);
});

/**
 * Idleness gates the turn-triggering claimed-request notification, which is
 * `notifyRequest`: it must hold both before the revalidating snapshot and
 * again after it, so a request that stopped being ours while the read was in
 * flight never wakes the agent. The passive terminal-outcome delivery in
 * `sync` is deliberately not idle-gated - it queues a non-triggering follow-up
 * mid-turn, pinned by agent-registry/delivery.test.ts.
 */
test("registry notifications revalidate claimed status only while the agent is idle", () => {
  assert.match(source, /notifiedRequests\.has\(request\.id\) \|\|\s*!ctx\.isIdle\(\) \|\|\s*ctx\.hasPendingMessages\(\) \|\|\s*autoReloadPending\(\)/);
  assert.match(source, /store\.snapshot\(Date\.now\(\)\)/);
  assert.match(source, /fresh\.status !== "claimed"/);
  assert.match(source, /fresh\.leaseId !== request\.leaseId/);
  assert.match(source, /fresh\.agentId !== identity\(ctx\)\.id/);
  assert.match(source, /fresh\.agentId !== identity\(ctx\)\.id \|\|\s*!ctx\.isIdle\(\) \|\|\s*ctx\.hasPendingMessages\(\) \|\|\s*autoReloadPending\(\)/);
  assert.match(source, /if \(notificationsEnabled && !notificationSent\)\s*notificationSent = await notifyRequest\(ctx, claimed\)/);
});

test("registry inbox wakes one idle owner without preempting human prompts", () => {
  assert.match(source, /ctx\.hasPendingMessages\(\)/);
  assert.match(source, /Operator inbox trigger/);
  assert.match(source, /triggerTurn: true, deliverAs: "followUp"/);
  assert.match(source, /genuine human prompt.*priority/i);
  assert.match(source, /let notificationSent = false/);
  assert.match(source, /notificationsEnabled && !notificationSent/);
});

test("registry follow-ups yield to a pending managed reload", () => {
  assert.match(source, /AUTO_RELOAD_PENDING_REQUEST_EVENT/);
  assert.match(source, /const autoReloadPending = \(\): boolean/);
  assert.match(source, /fresh\.agentId !== identity\(ctx\)\.id \|\|[\s\S]*autoReloadPending\(\)/);
});
