import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { BRIDGE_AGENT_TTL_MS, BRIDGE_MESSAGE_TTL_MS, RemoteBridgeError } from "./protocol.ts";
import { makeRemoteBridgeStore, type RemoteBridgeStore } from "./sqlite-store.ts";

const withStore = async (use: (store: RemoteBridgeStore) => Promise<void>): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-"));
  try {
    await use(makeRemoteBridgeStore(join(directory, "bridge.sqlite")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const heartbeat = (store: RemoteBridgeStore, now = 1_000) =>
  Effect.runPromise(
    store.heartbeatAgent({
      id: "session-1",
      label: "yielduck",
      cwd: "/work/yielduck",
      accepting: true,
      now,
      ttlMs: BRIDGE_AGENT_TTL_MS,
    }),
  );

const enqueue = (store: RemoteBridgeStore, now = 2_000, dedupeKey = "update-1") =>
  Effect.runPromise(
    store.enqueue({
      targetAgentId: "session-1",
      requesterId: "telegram-owner-42",
      dedupeKey,
      text: "what is the current status?",
      now,
      ttlMs: BRIDGE_MESSAGE_TTL_MS,
    }),
  );

test("a live bridge agent accepts one deduplicated durable message", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const first = await enqueue(store);
    const duplicate = await enqueue(store, 2_001);
    assert.equal(first.status, "queued");
    assert.equal(duplicate.id, first.id);
    assert.equal((await Effect.runPromise(store.listAgents(2_000))).length, 1);
  }));

test("claim and completion require the exact claim token", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const queued = await enqueue(store);
    const claimed = await Effect.runPromise(store.claimNext({ agentId: "session-1", now: 3_000 }));
    assert.equal(claimed?.status, "claimed");
    if (!claimed || claimed.status !== "claimed") return;

    const stale = await Effect.runPromise(
      Effect.either(
        store.complete({
          messageId: queued.id,
          claimToken: "wrong-token",
          response: "nope",
          now: 4_000,
        }),
      ),
    );
    assert.equal(stale._tag, "Left");
    if (stale._tag === "Left") {
      assert.ok(stale.left instanceof RemoteBridgeError);
      assert.equal(stale.left.code, "invalid_transition");
    }

    const completed = await Effect.runPromise(
      store.complete({
        messageId: queued.id,
        claimToken: claimed.claimToken,
        response: "all systems nominal",
        now: 4_001,
      }),
    );
    assert.equal(completed.status, "completed");
    if (completed.status === "completed") assert.equal(completed.response, "all systems nominal");
  }));

test("expired and disabled messages fail closed", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const queued = await enqueue(store);
    const expired = await Effect.runPromise(store.get(queued.id, 2_000 + BRIDGE_MESSAGE_TTL_MS));
    assert.equal(expired.status, "failed");
    if (expired.status === "failed") assert.equal(expired.failure, "expired");

    await Effect.runPromise(store.setEnabled(false));
    const disabled = await Effect.runPromise(
      Effect.either(
        store.enqueue({
          targetAgentId: "session-1",
          requesterId: "telegram-owner-42",
          dedupeKey: "update-2",
          text: "what is the current status?",
          now: 3_000,
          ttlMs: BRIDGE_MESSAGE_TTL_MS,
        }),
      ),
    );
    assert.equal(disabled._tag, "Left");
    if (disabled._tag === "Left") assert.equal(disabled.left.code, "disabled");
  }));

test("disabled bridge leaves queued work unclaimed", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const queued = await enqueue(store);
    await Effect.runPromise(store.setEnabled(false));
    assert.equal(await Effect.runPromise(store.claimNext({ agentId: "session-1", now: 3_000 })), undefined);
    assert.equal((await Effect.runPromise(store.get(queued.id, 3_001))).status, "queued");
  }));

test("terminal messages age out so dedupe and capacity do not wedge permanently", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const first = await enqueue(store);
    const claimed = await Effect.runPromise(store.claimNext({ agentId: "session-1", now: 3_000 }));
    assert.equal(claimed?.status, "claimed");
    if (!claimed || claimed.status !== "claimed") return;
    await Effect.runPromise(
      store.complete({ messageId: first.id, claimToken: claimed.claimToken, response: "done", now: 4_000 }),
    );

    const later = 4_000 + BRIDGE_MESSAGE_TTL_MS + 1;
    await heartbeat(store, later);
    const second = await enqueue(store, later, "update-1");
    assert.notEqual(second.id, first.id);
  }));

test("bridge store enforces owner-only directory and database permissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-mode-"));
  const stateDirectory = join(directory, "nested");
  const databasePath = join(stateDirectory, "bridge.sqlite");
  try {
    await Effect.runPromise(makeRemoteBridgeStore(databasePath).isEnabled());
    assert.equal(statSync(stateDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale agents disappear and cannot receive new messages", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    assert.deepEqual(await Effect.runPromise(store.listAgents(1_000 + BRIDGE_AGENT_TTL_MS)), []);
    const result = await Effect.runPromise(
      Effect.either(
        store.enqueue({
          targetAgentId: "session-1",
          requesterId: "telegram-owner-42",
          dedupeKey: "update-1",
          text: "what is the current status?",
          now: 20_000,
          ttlMs: BRIDGE_MESSAGE_TTL_MS,
        }),
      ),
    );
    assert.equal(result._tag, "Left");
    if (result._tag === "Left") assert.equal(result.left.code, "stale_agent");
  }));
