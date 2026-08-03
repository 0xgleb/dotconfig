import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_MESSAGE_TTL_MS,
  MAX_REMOTE_IMAGE_BYTES,
  MAX_REMOTE_MESSAGE_CHARACTERS,
  RemoteBridgeError,
  boundedBridgeImages,
  boundedBridgeText,
  finalAssistantText,
  mechanicalDispatchCompaction,
  normalizeLegacyRemoteImageContent,
  parseOutcomeEnvelope,
  parseOwnerRelay,
  parseRoutePlan,
  remoteTurnContent,
  remoteTurnPrompt,
  routingBatchPrompt,
  trimDispatchContext,
} from "./protocol.ts";

test("remote prompts are explicitly communication-only", () => {
  const prompt = remoteTurnPrompt("Give me a concise status update.", "conversational");
  assert.match(prompt, /Authenticated Piece of Pi Telegram/i);
  assert.match(prompt, /all tools are disabled/i);
  assert.match(prompt, /Do not execute or approve actions/i);
  assert.match(prompt, /Give me a concise status update/);
});

test("routing turns carry the roster and the whole numbered batch", () => {
  const prompt = routingBatchPrompt(
    [
      { index: 1, text: "ask ~/.config if it knows the song" },
      { index: 2, text: "yo ask the st0x agent to report what PRs are waiting" },
    ],
    [
      { id: "claude-config-receiver", label: "Claude Code (Fable) - .config receiver", cwd: "/Users/example/.config" },
      { id: "claude-st0x-receiver", label: "Claude Code - st0x receiver", cwd: "/Users/example/code/st0x" },
    ],
  );
  assert.match(prompt, /Authenticated Piece of Pi Telegram/i);
  assert.doesNotMatch(prompt, /no_think/);
  assert.match(prompt, /Think as long as you need/);
  assert.match(prompt, /route: <absolute project path> \| messages: <numbers>/);
  assert.match(prompt, /claude-st0x-receiver/);
  assert.match(prompt, /\[1\] ask ~\/\.config if it knows the song/);
  assert.match(prompt, /\[2\] yo ask the st0x agent/);
});

test("dispatch context slides: old turns drop behind a count marker", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "a".repeat(400) }] },
    { role: "assistant", content: [{ type: "text", text: "b".repeat(400) }] },
    { role: "user", content: [{ type: "text", text: "c".repeat(400) }] },
    { role: "assistant", content: [{ type: "text", text: "d".repeat(400) }] },
    { role: "user", content: [{ type: "text", text: "keep me" }] },
  ];
  const trimmed = trimDispatchContext(messages, 900);
  assert.equal(trimmed.dropped, 3);
  const first = trimmed.messages[0];
  assert.equal(first?.role, "user");
  assert.match(JSON.stringify(first), /3 earlier dispatch turns trimmed from context/);
  assert.equal(trimmed.messages.length, 3);
  assert.match(JSON.stringify(trimmed.messages.at(-1)), /keep me/);

  const untouched = trimDispatchContext(messages, 100_000);
  assert.equal(untouched.dropped, 0);
  assert.equal(untouched.messages, messages);
});

test("dispatch compaction completes mechanically without a summarization call", () => {
  const result = mechanicalDispatchCompaction({
    firstKeptEntryId: "entry-42",
    tokensBefore: 39_000,
  });
  assert.equal(result.firstKeptEntryId, "entry-42");
  assert.equal(result.tokensBefore, 39_000);
  assert.match(result.summary, /agent registry/);
  assert.ok(result.summary.length < 400);
});

test("owner-relay frames deliver outward instead of being routed as work", () => {
  assert.equal(
    parseOwnerRelay("relay-to-owner: напоминание - отправить инвойс"),
    "напоминание - отправить инвойс",
  );
  assert.equal(
    parseOwnerRelay("Relay to the owner on Telegram: reminder text here"),
    "reminder text here",
  );
  assert.equal(parseOwnerRelay("yo ask the st0x agent something"), undefined);
  assert.equal(parseOwnerRelay("relay-to-owner:"), undefined);
});

test("receiver outcome envelopes parse mechanically and never reach the routing turn", () => {
  const parsed = parseOutcomeEnvelope(
    "request:9fd6a20d-1f02-46bc-80d9-3212d829e2f2 outcome:completed summary:Принял напоминание про 20 долларов. evidence:registry-request-9fd6a20d",
  );
  assert.deepEqual(parsed, {
    requestId: "9fd6a20d-1f02-46bc-80d9-3212d829e2f2",
    outcome: "completed",
    summary: "Принял напоминание про 20 долларов.",
  });
  const failed = parseOutcomeEnvelope(
    "request:e554a597-ab2f-402e-a8ab-0582aa1881cc outcome:failed summary:dispatcher unreachable",
  );
  assert.equal(failed?.outcome, "failed");
  assert.equal(failed?.summary, "dispatcher unreachable");
  assert.equal(
    parseOutcomeEnvelope("request:db3f9039 outcome:completed summary:cadence re-armed")?.requestId,
    "db3f9039",
  );
  assert.equal(parseOutcomeEnvelope("yo ask the st0x agent to report to me"), undefined);
  assert.equal(parseOutcomeEnvelope("request:not-a-uuid outcome:completed summary:x"), undefined);
  assert.equal(
    parseOutcomeEnvelope("request:9fd6a20d-1f02-46bc-80d9-3212d829e2f2 outcome:exploded summary:x"),
    undefined,
  );
});

test("route plans split batches across agents and discard everything else", () => {
  const plan = parseRoutePlan(
    [
      "Okay, thinking about this batch.",
      "route: /Users/example/.config | messages: 1",
      "route: /Users/example/code/st0x | messages: 2, 3 | note: report the PR part only",
      "Hope that helps!",
    ].join("\n"),
    3,
  );
  assert.deepEqual(plan, [
    { project: "/Users/example/.config", indexes: [1] },
    {
      project: "/Users/example/code/st0x",
      indexes: [2, 3],
      note: "report the PR part only",
    },
  ]);
  assert.deepEqual(parseRoutePlan("no routing here", 2), []);
  assert.deepEqual(parseRoutePlan("route: relative | messages: 1", 2), []);
  assert.deepEqual(
    parseRoutePlan("route: /Users/example/.config | messages: 7, 1", 2),
    [{ project: "/Users/example/.config", indexes: [1] }],
  );
});

test("dispatch-lane remote prompts forbid answering and demand routing", () => {
  const prompt = remoteTurnPrompt("ask ~/.config if it knows the song", "dispatch");
  assert.match(prompt, /Authenticated Piece of Pi Telegram/i);
  assert.match(prompt, /all tools are disabled/i);
  assert.match(prompt, /never answer, analyze, or resolve/i);
  assert.match(prompt, /one short acknowledgement/i);
  assert.match(prompt, /routed raw/i);
  assert.match(prompt, /ask ~\/\.config if it knows the song/);
  assert.doesNotMatch(prompt, /Reply conversationally/);
});

test("owner messages retain a bounded one-hour delivery window", () => {
  assert.equal(BRIDGE_MESSAGE_TTL_MS, 60 * 60_000);
});

test("bridge text rejects control characters and oversized messages", () => {
  assert.throws(
    () => boundedBridgeText("message", "bad\u0000text", 100),
    RemoteBridgeError,
  );
  assert.throws(
    () =>
      boundedBridgeText(
        "message",
        "x".repeat(MAX_REMOTE_MESSAGE_CHARACTERS + 1),
        MAX_REMOTE_MESSAGE_CHARACTERS,
      ),
    RemoteBridgeError,
  );
});

test("remote image payloads use Pi image content accepted by model providers", () => {
  const image = {
    mediaType: "image/jpeg" as const,
    data: Buffer.from("safe-image-fixture").toString("base64"),
  };
  assert.deepEqual(boundedBridgeImages([image]), [image]);
  assert.deepEqual(remoteTurnContent("Describe this", [image], "conversational").at(-1), {
    type: "image",
    data: image.data,
    mimeType: image.mediaType,
  });
  assert.throws(
    () => boundedBridgeImages([{ ...image, data: "not base64!" }]),
    RemoteBridgeError,
  );
  assert.throws(
    () =>
      boundedBridgeImages([
        {
          ...image,
          data: Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1).toString("base64"),
        },
      ]),
    RemoteBridgeError,
  );
});

test("legacy remote image turns are normalized before model serialization", () => {
  const image = {
    mediaType: "image/jpeg" as const,
    data: Buffer.from("persisted-telegram-image").toString("base64"),
  };
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Describe this" },
        {
          type: "image" as const,
          source: { type: "base64" as const, ...image },
        },
      ],
      timestamp: 1,
    },
  ];

  assert.deepEqual(normalizeLegacyRemoteImageContent(messages), [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this" },
        { type: "image", data: image.data, mimeType: image.mediaType },
      ],
      timestamp: 1,
    },
  ]);
});

test("only bounded final assistant text becomes the bridge response", () => {
  assert.equal(
    finalAssistantText([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "private" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "toolCall", name: "bash" },
          { type: "text", text: "second" },
        ],
      },
    ]),
    "first\nsecond",
  );
  assert.equal(
    finalAssistantText([{ role: "user", content: "hello" }]),
    undefined,
  );
});
