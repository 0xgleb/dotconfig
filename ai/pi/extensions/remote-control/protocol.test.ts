import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REMOTE_IMAGE_BYTES,
  MAX_REMOTE_MESSAGE_CHARACTERS,
  RemoteBridgeError,
  boundedBridgeImages,
  boundedBridgeText,
  finalAssistantText,
  normalizeLegacyRemoteImageContent,
  remoteTurnContent,
  remoteTurnPrompt,
} from "./protocol.ts";

test("remote prompts are explicitly communication-only", () => {
  const prompt = remoteTurnPrompt("Give me a concise status update.");
  assert.match(prompt, /all tools are disabled/i);
  assert.match(prompt, /Do not execute or approve actions/i);
  assert.match(prompt, /Give me a concise status update/);
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
  assert.deepEqual(remoteTurnContent("Describe this", [image]).at(-1), {
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
