import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Effect } from "effect";
import {
  BRIDGE_AGENT_TTL_MS,
  BRIDGE_MESSAGE_TTL_MS,
  RemoteBridgeError,
} from "./protocol.ts";
import {
  makeRemoteBridgeStore,
  type RemoteBridgeStore,
} from "./sqlite-store.ts";

const withStore = async (
  use: (store: RemoteBridgeStore) => Promise<void>,
): Promise<void> => {
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

const enqueue = (
  store: RemoteBridgeStore,
  now = 2_000,
  dedupeKey = "update-1",
) =>
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

test("image payloads survive the durable enqueue and claim boundary", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const image = {
      mediaType: "image/jpeg" as const,
      data: Buffer.from("image-fixture").toString("base64"),
    };
    const queued = await Effect.runPromise(
      store.enqueue({
        targetAgentId: "session-1",
        requesterId: "telegram-owner-42",
        dedupeKey: "photo-update-1",
        text: "Can you see this?",
        images: [image],
        now: 2_000,
        ttlMs: BRIDGE_MESSAGE_TTL_MS,
      }),
    );
    assert.deepEqual(queued.images, [image]);
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 3_000 }),
    );
    assert.deepEqual(claimed?.images, [image]);
  }));

test("claim and completion require the exact claim token", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const queued = await enqueue(store);
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 3_000 }),
    );
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
    if (completed.status === "completed")
      assert.equal(completed.response, "all systems nominal");
  }));

test("expired and disabled messages fail closed", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const queued = await enqueue(store);
    const expired = await Effect.runPromise(
      store.get(queued.id, 2_000 + BRIDGE_MESSAGE_TTL_MS),
    );
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
    assert.equal(
      await Effect.runPromise(
        store.claimNext({ agentId: "session-1", now: 3_000 }),
      ),
      undefined,
    );
    assert.equal(
      (await Effect.runPromise(store.get(queued.id, 3_001))).status,
      "queued",
    );
  }));

test("terminal messages age out so dedupe and capacity do not wedge permanently", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    const first = await enqueue(store);
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 3_000 }),
    );
    assert.equal(claimed?.status, "claimed");
    if (!claimed || claimed.status !== "claimed") return;
    await Effect.runPromise(
      store.complete({
        messageId: first.id,
        claimToken: claimed.claimToken,
        response: "done",
        now: 4_000,
      }),
    );

    const later = 4_000 + BRIDGE_MESSAGE_TTL_MS + 1;
    await heartbeat(store, later);
    const second = await enqueue(store, later, "update-1");
    assert.notEqual(second.id, first.id);
  }));

test("protocol v1 databases migrate additively through image relay v3", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-v1-"));
  const databasePath = join(directory, "bridge.sqlite");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE bridge_agents (
        agent_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        cwd TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepting INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE bridge_messages (
        message_id TEXT PRIMARY KEY,
        target_agent_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        claim_token TEXT,
        claimed_at INTEGER,
        response TEXT,
        failure TEXT,
        completed_at INTEGER,
        UNIQUE (requester_id, dedupe_key)
      ) STRICT;
      CREATE INDEX bridge_messages_target_status
        ON bridge_messages (target_agent_id, status, created_at);
      CREATE TABLE bridge_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO bridge_settings (key, value) VALUES ('enabled', '1');
      PRAGMA user_version = 1;
    `);
    database.close();

    const store = makeRemoteBridgeStore(databasePath);
    assert.equal(await Effect.runPromise(store.isEnabled()), true);
    assert.deepEqual(
      await Effect.runPromise(store.listUnrelayedQuestions(1_000)),
      [],
    );
    await heartbeat(store);
    assert.deepEqual((await enqueue(store)).images, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("Telegram replies resolve only the exact bound agent question", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    await Effect.runPromise(
      store.syncQuestions({
        agentId: "session-1",
        now: 2_000,
        questions: [
          {
            id: 1,
            status: "pending",
            question: "Ship the release?",
            header: "Release",
            guess: "Wait",
            options: [{ label: "Ship" }, { label: "Wait" }],
          },
          { id: 2, status: "pending", question: "Enable alerts?" },
        ],
      }),
    );

    const pending = await Effect.runPromise(
      store.listUnrelayedQuestions(2_001),
    );
    assert.deepEqual(
      pending.map(({ agentId, questionId }) => ({ agentId, questionId })),
      [
        { agentId: "session-1", questionId: 1 },
        { agentId: "session-1", questionId: 2 },
      ],
    );

    await Effect.runPromise(
      store.linkTelegramQuestion({
        agentId: "session-1",
        questionId: 1,
        chatId: 42,
        messageId: 77,
        now: 2_002,
      }),
    );

    const unknown = await Effect.runPromise(
      Effect.either(
        store.answerTelegramQuestion({
          chatId: 42,
          messageId: 78,
          answer: "Ship",
          now: 2_003,
        }),
      ),
    );
    assert.equal(unknown._tag, "Left");
    if (unknown._tag === "Left") assert.equal(unknown.left.code, "not_found");

    const answered = await Effect.runPromise(
      store.answerTelegramQuestion({
        chatId: 42,
        messageId: 77,
        answer: "Ship",
        now: 2_004,
      }),
    );
    assert.deepEqual(answered, {
      agentId: "session-1",
      questionId: 1,
      answer: "Ship",
    });

    const replay = await Effect.runPromise(
      Effect.either(
        store.answerTelegramQuestion({
          chatId: 42,
          messageId: 77,
          answer: "Wait",
          now: 2_005,
        }),
      ),
    );
    assert.equal(replay._tag, "Left");
    if (replay._tag === "Left")
      assert.equal(replay.left.code, "invalid_transition");

    assert.equal(
      await Effect.runPromise(
        store.takeQuestionResolution({ agentId: "other-session", now: 2_006 }),
      ),
      undefined,
    );
    assert.deepEqual(
      await Effect.runPromise(
        store.takeQuestionResolution({ agentId: "session-1", now: 2_007 }),
      ),
      answered,
    );
    assert.equal(
      await Effect.runPromise(
        store.takeQuestionResolution({ agentId: "session-1", now: 2_008 }),
      ),
      undefined,
    );
  }));

test("stale agents disappear and cannot receive new messages", async () =>
  withStore(async (store) => {
    await heartbeat(store);
    assert.deepEqual(
      await Effect.runPromise(store.listAgents(1_000 + BRIDGE_AGENT_TTL_MS)),
      [],
    );
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
