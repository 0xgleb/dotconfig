import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Effect } from "effect"
import {
  BRIDGE_AGENT_TTL_MS,
  BRIDGE_MESSAGE_TTL_MS,
  BRIDGE_PROTOCOL_VERSION,
  RemoteBridgeError,
} from "./protocol.ts"
import {
  makeRemoteBridgeStore,
  type RemoteBridgeStore,
} from "./sqlite-store.ts"

const withStore = async (
  use: (store: RemoteBridgeStore) => Promise<void>,
): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-"))
  try {
    await use(makeRemoteBridgeStore(join(directory, "bridge.sqlite")))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const heartbeat = (store: RemoteBridgeStore, now = 1_000) =>
  Effect.runPromise(
    store.heartbeatAgent({
      id: "session-1",
      label: "yielduck",
      cwd: "/work/yielduck",
      accepting: true,
      workDelivery: "native-pi",
      now,
      ttlMs: BRIDGE_AGENT_TTL_MS,
    }),
  )

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
  )

test("a live bridge agent accepts one deduplicated durable message", async () =>
  withStore(async store => {
    await heartbeat(store)
    const first = await enqueue(store)
    const duplicate = await enqueue(store, 2_001)
    assert.equal(first.status, "queued")
    assert.equal(duplicate.id, first.id)
    assert.equal((await Effect.runPromise(store.listAgents(2_000))).length, 1)
  }))

test("monitor-only and inline-only agents reject queued work explicitly", async () =>
  withStore(async store => {
    for (const workDelivery of ["monitor-only", "inline-only"] as const) {
      const id = `agent-${workDelivery}`
      await Effect.runPromise(
        store.heartbeatAgent({
          id,
          label: id,
          cwd: "/work/monitor",
          accepting: true,
          workDelivery,
          now: 1_000,
          ttlMs: BRIDGE_AGENT_TTL_MS,
        }),
      )
      const result = await Effect.runPromise(
        Effect.either(
          store.enqueue({
            targetAgentId: id,
            requesterId: "dispatcher",
            dedupeKey: `work-${workDelivery}`,
            text: "queued work",
            now: 2_000,
            ttlMs: BRIDGE_MESSAGE_TTL_MS,
          }),
        ),
      )
      assert.equal(result._tag, "Left")
      if (result._tag === "Left") {
        assert.equal(result.left.code, "undrainable_agent")
      }
    }
  }))

test("image payloads survive the durable enqueue and claim boundary", async () =>
  withStore(async store => {
    await heartbeat(store)
    const image = {
      mediaType: "image/jpeg" as const,
      data: Buffer.from("image-fixture").toString("base64"),
    }
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
    )
    assert.deepEqual(queued.images, [image])
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 3_000 }),
    )
    assert.deepEqual(claimed?.images, [image])
  }))

test("claim and completion require the exact claim token", async () =>
  withStore(async store => {
    await heartbeat(store)
    const queued = await enqueue(store)
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 3_000 }),
    )
    assert.equal(claimed?.status, "claimed")
    if (!claimed || claimed.status !== "claimed") return

    const stale = await Effect.runPromise(
      Effect.either(
        store.complete({
          messageId: queued.id,
          claimToken: "wrong-token",
          response: "nope",
          now: 4_000,
        }),
      ),
    )
    assert.equal(stale._tag, "Left")
    if (stale._tag === "Left") {
      assert.ok(stale.left instanceof RemoteBridgeError)
      assert.equal(stale.left.code, "invalid_transition")
    }

    const completed = await Effect.runPromise(
      store.complete({
        messageId: queued.id,
        claimToken: claimed.claimToken,
        response: "all systems nominal",
        now: 4_001,
      }),
    )
    assert.equal(completed.status, "completed")
    if (completed.status === "completed")
      assert.equal(completed.response, "all systems nominal")
  }))

test("expired and disabled messages fail closed", async () =>
  withStore(async store => {
    await heartbeat(store)
    const queued = await enqueue(store)
    const expired = await Effect.runPromise(
      store.get(queued.id, 2_000 + BRIDGE_MESSAGE_TTL_MS),
    )
    assert.equal(expired.status, "failed")
    if (expired.status === "failed") assert.equal(expired.failure, "expired")

    await Effect.runPromise(store.setEnabled(false))
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
    )
    assert.equal(disabled._tag, "Left")
    if (disabled._tag === "Left") assert.equal(disabled.left.code, "disabled")
  }))

test("expired messages retain whether an agent had claimed execution", async () =>
  withStore(async store => {
    await heartbeat(store)
    const queued = await enqueue(store)
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 2_100 }),
    )
    assert.ok(claimed)
    const expired = await Effect.runPromise(
      store.get(queued.id, 2_100 + BRIDGE_MESSAGE_TTL_MS),
    )
    assert.equal(expired.status, "failed")
    if (expired.status === "failed") assert.equal(expired.claimedAt, 2_100)
  }))

test("claiming restarts the deadline so a lane does not lose work mid-handling", async () =>
  withStore(async store => {
    await heartbeat(store)
    const queued = await enqueue(store)
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 2_100 }),
    )
    assert.equal(claimed?.status, "claimed")
    assert.equal(claimed?.expiresAt, 2_100 + BRIDGE_MESSAGE_TTL_MS)

    const held = await Effect.runPromise(
      store.get(queued.id, 2_000 + BRIDGE_MESSAGE_TTL_MS + 1),
    )
    assert.equal(held.status, "claimed")
  }))

test("disabled bridge leaves queued work unclaimed", async () =>
  withStore(async store => {
    await heartbeat(store)
    const queued = await enqueue(store)
    await Effect.runPromise(store.setEnabled(false))
    assert.equal(
      await Effect.runPromise(
        store.claimNext({ agentId: "session-1", now: 3_000 }),
      ),
      undefined,
    )
    assert.equal(
      (await Effect.runPromise(store.get(queued.id, 3_001))).status,
      "queued",
    )
  }))

test("terminal messages age out so dedupe and capacity do not wedge permanently", async () =>
  withStore(async store => {
    await heartbeat(store)
    const first = await enqueue(store)
    const claimed = await Effect.runPromise(
      store.claimNext({ agentId: "session-1", now: 3_000 }),
    )
    assert.equal(claimed?.status, "claimed")
    if (!claimed || claimed.status !== "claimed") return
    await Effect.runPromise(
      store.complete({
        messageId: first.id,
        claimToken: claimed.claimToken,
        response: "done",
        now: 4_000,
      }),
    )

    const later = 4_000 + BRIDGE_MESSAGE_TTL_MS + 1
    await heartbeat(store, later)
    const second = await enqueue(store, later, "update-1")
    assert.notEqual(second.id, first.id)
  }))

test("protocol v1 databases migrate additively with typed delivery and stranded queue visibility", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-v1-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    const database = new DatabaseSync(databasePath)
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
      INSERT INTO bridge_agents (
        agent_id, label, cwd, heartbeat_at, expires_at, accepting
      ) VALUES ('legacy-monitor', 'Legacy monitor', '/work/legacy', 1000, 10000, 1);
      INSERT INTO bridge_messages (
        message_id, target_agent_id, requester_id, dedupe_key, text,
        created_at, expires_at, updated_at, status
      ) VALUES (
        'legacy-message', 'legacy-monitor', 'dispatcher', 'legacy-dedupe',
        'stranded work', 1000, 10000, 1000, 'queued'
      );
      PRAGMA user_version = 1;
    `)
    database.close()

    const store = makeRemoteBridgeStore(databasePath)
    assert.equal(await Effect.runPromise(store.isEnabled()), true)
    assert.deepEqual(
      await Effect.runPromise(store.listUnrelayedQuestions(1_000)),
      [],
    )
    const [legacy] = await Effect.runPromise(store.listAgents(2_000))
    assert.equal(legacy?.workDelivery, "monitor-only")
    assert.equal(legacy?.queuedMessages, 1)
    const undrainableClaim = await Effect.runPromise(
      Effect.either(store.claimNext({ agentId: "legacy-monitor", now: 2_001 })),
    )
    assert.equal(undrainableClaim._tag, "Left")
    if (undrainableClaim._tag === "Left") {
      assert.equal(undrainableClaim.left.code, "undrainable_agent")
    }
    await heartbeat(store)
    assert.deepEqual((await enqueue(store)).images, [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("protocol v5 databases missing the typed delivery column repair additively", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-v5-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    const database = new DatabaseSync(databasePath)
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
        images_json TEXT NOT NULL DEFAULT '[]',
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
      PRAGMA user_version = 5;
    `)
    database.close()

    const store = makeRemoteBridgeStore(databasePath)
    const agent = await heartbeat(store)
    assert.equal(agent.workDelivery, "native-pi")

    const migrated = new DatabaseSync(databasePath)
    const version = migrated.prepare("PRAGMA user_version").get() as {
      user_version: number
    }
    const columns = migrated
      .prepare("PRAGMA table_info(bridge_agents)")
      .all() as Array<{ name: string }>
    migrated.close()
    assert.equal(version.user_version, BRIDGE_PROTOCOL_VERSION)
    assert.ok(columns.some(({ name }) => name === "work_delivery"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("protocol v6 repairs a missing conversation-delivery table", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-v6-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE bridge_agents (
        agent_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        cwd TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepting INTEGER NOT NULL,
        work_delivery TEXT NOT NULL DEFAULT 'monitor-only'
      ) STRICT;
      CREATE TABLE bridge_messages (
        message_id TEXT PRIMARY KEY,
        target_agent_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        text TEXT NOT NULL,
        images_json TEXT NOT NULL DEFAULT '[]',
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
      CREATE TABLE bridge_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO bridge_settings (key, value) VALUES ('enabled', '1');
      PRAGMA user_version = 6;
    `)
    database.close()

    const store = makeRemoteBridgeStore(databasePath)
    assert.equal(await Effect.runPromise(store.isEnabled()), true)

    const repaired = new DatabaseSync(databasePath)
    const table = repaired
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bridge_question_delivery_channels'",
      )
      .get()
    repaired.close()
    assert.ok(table)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("protocol v6 rejects a malformed conversation-delivery table", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-v6-bad-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    assert.equal(
      await Effect.runPromise(makeRemoteBridgeStore(databasePath).isEnabled()),
      true,
    )
    const database = new DatabaseSync(databasePath)
    database.exec(`
      DROP TABLE bridge_question_delivery_channels;
      CREATE TABLE bridge_question_delivery_channels (
        agent_id TEXT
      ) STRICT;
      PRAGMA user_version = 6;
    `)
    database.close()

    const result = await Effect.runPromise(
      Effect.either(makeRemoteBridgeStore(databasePath).isEnabled()),
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") assert.equal(result.left.code, "corrupt_state")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("protocol v6 rejects a conversation-delivery table without its channel constraint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-v6-check-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    assert.equal(
      await Effect.runPromise(makeRemoteBridgeStore(databasePath).isEnabled()),
      true,
    )
    const database = new DatabaseSync(databasePath)
    database.exec(`
      DROP TABLE bridge_question_delivery_channels;
      CREATE TABLE bridge_question_delivery_channels (
        agent_id TEXT NOT NULL,
        question_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, question_id)
      ) STRICT;
      PRAGMA user_version = 6;
    `)
    database.close()

    const result = await Effect.runPromise(
      Effect.either(makeRemoteBridgeStore(databasePath).isEnabled()),
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") assert.equal(result.left.code, "corrupt_state")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("protocol v6 removes orphan conversation-delivery markers on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-orphan-question-marker-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    const store = makeRemoteBridgeStore(databasePath)
    await heartbeat(store)
    const database = new DatabaseSync(databasePath)
    database
      .prepare(
        `INSERT INTO bridge_question_delivery_channels (
           agent_id, question_id, channel, delivered_at
         ) VALUES (?, ?, 'conversation', ?)`,
      )
      .run("session-1", 3, 2_000)
    database.close()

    const restarted = makeRemoteBridgeStore(databasePath)
    assert.equal(await Effect.runPromise(restarted.isEnabled()), true)
    await Effect.runPromise(
      restarted.syncQuestions({
        agentId: "session-1",
        now: 2_001,
        questions: [{ id: 3, status: "pending", question: "What verdict?" }],
      }),
    )
    assert.deepEqual(
      (await Effect.runPromise(restarted.listUnrelayedQuestions(2_002))).map(
        ({ questionId }) => questionId,
      ),
      [3],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("bridge store enforces owner-only directory and database permissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-remote-bridge-mode-"))
  const stateDirectory = join(directory, "nested")
  const databasePath = join(stateDirectory, "bridge.sqlite")
  try {
    await Effect.runPromise(makeRemoteBridgeStore(databasePath).isEnabled())
    assert.equal(statSync(stateDirectory).mode & 0o777, 0o700)
    assert.equal(statSync(databasePath).mode & 0o777, 0o600)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Telegram replies resolve only the exact bound agent question", async () =>
  withStore(async store => {
    await heartbeat(store)
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
    )

    const pending = await Effect.runPromise(store.listUnrelayedQuestions(2_001))
    assert.deepEqual(
      pending.map(({ agentId, questionId }) => ({ agentId, questionId })),
      [
        { agentId: "session-1", questionId: 1 },
        { agentId: "session-1", questionId: 2 },
      ],
    )

    assert.equal(
      await Effect.runPromise(
        store.isQuestionRelayed({ agentId: "session-1", questionId: 1 }),
      ),
      false,
    )

    await Effect.runPromise(
      store.linkTelegramQuestion({
        agentId: "session-1",
        questionId: 1,
        chatId: 42,
        messageId: 77,
        now: 2_002,
      }),
    )
    assert.deepEqual(
      (await Effect.runPromise(store.listPendingQuestions(2_003))).map(
        ({ agentId, questionId }) => ({ agentId, questionId }),
      ),
      [
        { agentId: "session-1", questionId: 1 },
        { agentId: "session-1", questionId: 2 },
      ],
    )

    assert.equal(
      await Effect.runPromise(
        store.isQuestionRelayed({ agentId: "session-1", questionId: 1 }),
      ),
      true,
    )

    const unknown = await Effect.runPromise(
      Effect.either(
        store.answerTelegramQuestion({
          chatId: 42,
          messageId: 78,
          answer: "Ship",
          now: 2_003,
        }),
      ),
    )
    assert.equal(unknown._tag, "Left")
    if (unknown._tag === "Left") assert.equal(unknown.left.code, "not_found")

    const answered = await Effect.runPromise(
      store.answerTelegramQuestion({
        chatId: 42,
        messageId: 77,
        answer: "Ship",
        now: 2_004,
      }),
    )
    assert.deepEqual(answered, {
      agentId: "session-1",
      questionId: 1,
      answer: "Ship",
    })

    const replay = await Effect.runPromise(
      Effect.either(
        store.answerTelegramQuestion({
          chatId: 42,
          messageId: 77,
          answer: "Wait",
          now: 2_005,
        }),
      ),
    )
    assert.equal(replay._tag, "Left")
    if (replay._tag === "Left")
      assert.equal(replay.left.code, "invalid_transition")

    assert.equal(
      await Effect.runPromise(
        store.takeQuestionResolution({ agentId: "other-session", now: 2_006 }),
      ),
      undefined,
    )
    assert.deepEqual(
      await Effect.runPromise(
        store.takeQuestionResolution({ agentId: "session-1", now: 2_007 }),
      ),
      answered,
    )
    assert.equal(
      await Effect.runPromise(
        store.takeQuestionResolution({ agentId: "session-1", now: 2_008 }),
      ),
      undefined,
    )

    await Effect.runPromise(
      store.syncQuestions({ agentId: "session-1", now: 2_009, questions: [] }),
    )
    assert.equal(
      await Effect.runPromise(
        store.isQuestionRelayed({ agentId: "session-1", questionId: 1 }),
      ),
      false,
    )
    assert.equal(
      await Effect.runPromise(
        store.isQuestionHistoricallyRelayed({
          agentId: "session-1",
          questionId: 1,
        }),
      ),
      true,
    )
  }))

test("conversation delivery requires an existing pending unlinked question", async () =>
  withStore(async store => {
    await heartbeat(store)
    const missing = await Effect.runPromise(
      Effect.either(
        store.markQuestionDeliveredInConversation({
          agentId: "session-1",
          questionId: 3,
          now: 2_000,
        }),
      ),
    )
    assert.equal(missing._tag, "Left")
    if (missing._tag === "Left") assert.equal(missing.left.code, "not_found")

    await Effect.runPromise(
      store.syncQuestions({
        agentId: "session-1",
        now: 2_001,
        questions: [{ id: 3, status: "pending", question: "What verdict?" }],
      }),
    )
    await Effect.runPromise(
      store.linkTelegramQuestion({
        agentId: "session-1",
        questionId: 3,
        chatId: 42,
        messageId: 77,
        now: 2_002,
      }),
    )
    const linked = await Effect.runPromise(
      Effect.either(
        store.markQuestionDeliveredInConversation({
          agentId: "session-1",
          questionId: 3,
          now: 2_003,
        }),
      ),
    )
    assert.equal(linked._tag, "Left")
    if (linked._tag === "Left")
      assert.equal(linked.left.code, "invalid_transition")
  }))

test("conversation-delivered pending questions are not replayed to Telegram after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-conversation-question-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    const store = makeRemoteBridgeStore(databasePath)
    await heartbeat(store)
    await Effect.runPromise(
      store.syncQuestions({
        agentId: "session-1",
        now: 2_000,
        questions: [
          {
            id: 3,
            status: "pending",
            question: "What verdict should I relay?",
          },
        ],
      }),
    )

    const conversationStore = store as RemoteBridgeStore & {
      readonly markQuestionDeliveredInConversation: (input: {
        readonly agentId: string
        readonly questionId: number
        readonly now: number
      }) => Effect.Effect<void, RemoteBridgeError>
    }
    await Effect.runPromise(
      conversationStore.markQuestionDeliveredInConversation({
        agentId: "session-1",
        questionId: 3,
        now: 2_001,
      }),
    )

    const restarted = makeRemoteBridgeStore(databasePath)
    assert.deepEqual(
      await Effect.runPromise(restarted.listUnrelayedQuestions(2_002)),
      [],
    )
    assert.deepEqual(
      (await Effect.runPromise(restarted.listPendingQuestions(2_002))).map(
        ({ questionId }) => questionId,
      ),
      [3],
    )

    await Effect.runPromise(
      restarted.syncQuestions({
        agentId: "session-1",
        now: 2_003,
        questions: [
          {
            id: 3,
            status: "resolved",
            question: "What verdict should I relay?",
          },
        ],
      }),
    )
    await Effect.runPromise(
      restarted.syncQuestions({
        agentId: "session-1",
        now: 2_004,
        questions: [
          {
            id: 3,
            status: "pending",
            question: "What verdict should I relay?",
          },
        ],
      }),
    )
    assert.deepEqual(
      (await Effect.runPromise(restarted.listUnrelayedQuestions(2_005))).map(
        ({ questionId }) => questionId,
      ),
      [3],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a bare numbered answer binds only to the sole pending delivered question", async () =>
  withStore(async store => {
    await heartbeat(store)
    await Effect.runPromise(
      store.syncQuestions({
        agentId: "session-1",
        now: 2_000,
        questions: [
          {
            id: 41,
            status: "pending",
            question: "What verdict?",
            options: [
              { label: "Approve" },
              { label: "Request changes" },
              { label: "Inspect first" },
            ],
          },
        ],
      }),
    )
    await Effect.runPromise(
      store.linkTelegramQuestion({
        agentId: "session-1",
        questionId: 41,
        chatId: 42,
        messageId: 77,
        now: 2_001,
      }),
    )

    assert.deepEqual(
      await Effect.runPromise(
        store.answerSolePendingTelegramQuestion({
          chatId: 42,
          answer: "3",
          now: 2_002,
        }),
      ),
      { agentId: "session-1", questionId: 41, answer: "Inspect first" },
    )
  }))

test("a bare numbered answer stays unbound when multiple delivered questions or no matching option exist", async () =>
  withStore(async store => {
    await heartbeat(store)
    await Effect.runPromise(
      store.syncQuestions({
        agentId: "session-1",
        now: 2_000,
        questions: [
          {
            id: 1,
            status: "pending",
            question: "First?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
          {
            id: 2,
            status: "pending",
            question: "Second?",
            options: [{ label: "Left" }, { label: "Right" }],
          },
        ],
      }),
    )
    for (const [questionId, messageId] of [
      [1, 77],
      [2, 78],
    ] as const) {
      await Effect.runPromise(
        store.linkTelegramQuestion({
          agentId: "session-1",
          questionId,
          chatId: 42,
          messageId,
          now: 2_001 + questionId,
        }),
      )
    }

    assert.equal(
      await Effect.runPromise(
        store.answerSolePendingTelegramQuestion({
          chatId: 42,
          answer: "1",
          now: 2_010,
        }),
      ),
      undefined,
    )
    await Effect.runPromise(
      store.dismissQuestion({
        agentId: "session-1",
        questionId: 2,
        now: 2_011,
      }),
    )
    assert.equal(
      await Effect.runPromise(
        store.answerSolePendingTelegramQuestion({
          chatId: 42,
          answer: "3",
          now: 2_012,
        }),
      ),
      undefined,
    )
  }))

test("Telegram resolution removes a legacy conversation-delivery marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-legacy-question-marker-"))
  const databasePath = join(directory, "bridge.sqlite")
  try {
    const store = makeRemoteBridgeStore(databasePath)
    await heartbeat(store)
    await Effect.runPromise(
      store.syncQuestions({
        agentId: "session-1",
        now: 2_000,
        questions: [{ id: 3, status: "pending", question: "What verdict?" }],
      }),
    )
    await Effect.runPromise(
      store.linkTelegramQuestion({
        agentId: "session-1",
        questionId: 3,
        chatId: 42,
        messageId: 77,
        now: 2_001,
      }),
    )
    const legacy = new DatabaseSync(databasePath)
    legacy
      .prepare(
        `INSERT INTO bridge_question_delivery_channels (
           agent_id, question_id, channel, delivered_at
         ) VALUES (?, ?, 'conversation', ?)`,
      )
      .run("session-1", 3, 2_002)
    legacy.close()

    await Effect.runPromise(
      store.answerTelegramQuestion({
        chatId: 42,
        messageId: 77,
        answer: "Request changes",
        now: 2_003,
      }),
    )
    const verified = new DatabaseSync(databasePath)
    const markers = verified
      .prepare(
        `SELECT COUNT(*) AS count
         FROM bridge_question_delivery_channels
         WHERE agent_id = ? AND question_id = ?`,
      )
      .get("session-1", 3) as { count: number }
    verified.close()
    assert.equal(markers.count, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an agent withdraws its own pending card but never one the owner answered", async () =>
  withStore(async store => {
    await heartbeat(store)
    await Effect.runPromise(
      store.syncQuestions({
        agentId: "session-1",
        now: 2_000,
        questions: [
          { id: 1, status: "pending", question: "Which direction?" },
          { id: 2, status: "pending", question: "Superseded out of band." },
        ],
      }),
    )

    const dismissed = await Effect.runPromise(
      store.dismissQuestion({
        agentId: "session-1",
        questionId: 2,
        now: 2_001,
      }),
    )
    assert.equal(dismissed.questionId, 2)
    assert.deepEqual(
      (await Effect.runPromise(store.listPendingQuestions(2_002))).map(
        ({ questionId }) => questionId,
      ),
      [1],
    )

    const foreign = await Effect.runPromise(
      Effect.either(
        store.dismissQuestion({
          agentId: "other-session",
          questionId: 1,
          now: 2_003,
        }),
      ),
    )
    assert.equal(foreign._tag, "Left")
    if (foreign._tag === "Left") assert.equal(foreign.left.code, "not_found")

    await Effect.runPromise(
      store.linkTelegramQuestion({
        agentId: "session-1",
        questionId: 1,
        chatId: 42,
        messageId: 77,
        now: 2_004,
      }),
    )
    await Effect.runPromise(
      store.answerTelegramQuestion({
        chatId: 42,
        messageId: 77,
        answer: "Inbox verb",
        now: 2_005,
      }),
    )

    const answered = await Effect.runPromise(
      Effect.either(
        store.dismissQuestion({
          agentId: "session-1",
          questionId: 1,
          now: 2_006,
        }),
      ),
    )
    assert.equal(answered._tag, "Left")
    if (answered._tag === "Left")
      assert.equal(answered.left.code, "invalid_transition")

    assert.equal(
      (
        await Effect.runPromise(
          store.takeQuestionResolution({ agentId: "session-1", now: 2_007 }),
        )
      )?.answer,
      "Inbox verb",
    )
  }))

test("stale agents disappear and cannot receive new messages", async () =>
  withStore(async store => {
    await heartbeat(store)
    assert.deepEqual(
      await Effect.runPromise(store.listAgents(1_000 + BRIDGE_AGENT_TTL_MS)),
      [],
    )
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
    )
    assert.equal(result._tag, "Left")
    if (result._tag === "Left") assert.equal(result.left.code, "stale_agent")
  }))
