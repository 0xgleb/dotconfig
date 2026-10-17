import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeChatRegistry,
  knownChatNames,
  normalizedChatName,
  recordGroupChat,
  resolveChat,
  MAX_REGISTERED_CHATS,
} from "./chat-registry.ts"

test("a chat name is what both an agent and the owner can retype", () => {
  assert.equal(normalizedChatName("St0x · Core Team!"), "st0x-core-team")
  assert.equal(normalizedChatName("Кланкер Лаб"), "кланкер-лаб")
  assert.equal(normalizedChatName("   "), undefined)
  assert.equal(normalizedChatName("···"), undefined)
})

test("a group chat the owner spoke in becomes an addressable target", () => {
  const registration = recordGroupChat(
    {},
    { id: -1001234567890, title: "St0x Core Team" },
  )

  assert.equal(registration.outcome, "recorded")
  if (registration.outcome !== "recorded") return
  assert.equal(registration.name, "st0x-core-team")
  assert.deepEqual(registration.chats, {
    "st0x-core-team": { id: -1001234567890, title: "St0x Core Team" },
  })
})

test("a positive chat id is a private chat and is never a group target", () => {
  assert.deepEqual(recordGroupChat({}, { id: 42, title: "Owner DM" }), {
    outcome: "unchanged",
  })
  assert.deepEqual(recordGroupChat({}, { id: 0, title: "Owner DM" }), {
    outcome: "unchanged",
  })
  assert.deepEqual(recordGroupChat({}, { id: -1.5, title: "Not an integer" }), {
    outcome: "unchanged",
  })
})

test("an already recorded chat does not rewrite the state file", () => {
  assert.deepEqual(
    recordGroupChat(
      { lab: { id: -100, title: "Lab" } },
      {
        id: -100,
        title: "Lab",
      },
    ),
    { outcome: "unchanged" },
  )
})

test("a renamed chat moves instead of answering to two names", () => {
  const renamed = recordGroupChat(
    { lab: { id: -100, title: "Lab" } },
    {
      id: -100,
      title: "Lab v2",
    },
  )

  assert.equal(renamed.outcome, "recorded")
  if (renamed.outcome !== "recorded") return
  assert.equal(renamed.name, "lab-v2")
  assert.deepEqual(renamed.chats, {
    "lab-v2": { id: -100, title: "Lab v2" },
  })
})

test("a title with no addressable characters cannot be recorded", () => {
  assert.deepEqual(recordGroupChat({}, { id: -100, title: "···" }), {
    outcome: "unchanged",
  })
  assert.deepEqual(recordGroupChat({}, { id: -100, title: "x".repeat(129) }), {
    outcome: "unchanged",
  })
})

test("the registry stops growing instead of filling the state file", () => {
  const chats = Object.fromEntries(
    Array.from({ length: MAX_REGISTERED_CHATS }, (_unused, index) => [
      `chat-${index}`,
      { id: -(index + 1), title: `Chat ${index}` },
    ]),
  )

  assert.deepEqual(recordGroupChat(chats, { id: -999, title: "One More" }), {
    outcome: "unchanged",
  })
  assert.equal(
    recordGroupChat(chats, { id: -1, title: "Chat 0 Renamed" }).outcome,
    "recorded",
  )
})

test("a state file with no chats field still loads", () => {
  assert.deepEqual(decodeChatRegistry(undefined), {})
  assert.deepEqual(decodeChatRegistry(null), {})
  assert.deepEqual(decodeChatRegistry([{ id: -1, title: "Lab" }]), {})
  assert.deepEqual(decodeChatRegistry("chats"), {})
})

test("a malformed registry entry is dropped instead of failing the load", () => {
  const decoded = decodeChatRegistry(
    JSON.parse(
      JSON.stringify({
        "lab": { id: -100, title: "Lab" },
        "private-dm": { id: 42, title: "Owner DM" },
        "no-title": { id: -101 },
        "not-an-object": "-102",
        "fractional-id": { id: -1.5, title: "Broken" },
        "Not Normalized": { id: -103, title: "Skipped" },
        "long-title": { id: -104, title: "x".repeat(129) },
      }),
    ),
  )

  assert.deepEqual(decoded, { lab: { id: -100, title: "Lab" } })
})

test("a prototype-shaped key never enters the registry", () => {
  const decoded = decodeChatRegistry(
    JSON.parse('{"__proto__": {"id": -100, "title": "Lab"}}'),
  )

  assert.deepEqual(Object.keys(decoded), [])
  assert.equal(({} as Record<string, unknown>).id, undefined)
})

test("chats resolve by name however the caller spelled it", () => {
  const chats = {
    "st0x-core-team": { id: -100, title: "St0x Core Team" },
    "lab": { id: -101, title: "Lab" },
  }

  assert.deepEqual(resolveChat(chats, "St0x Core Team"), {
    id: -100,
    title: "St0x Core Team",
  })
  assert.deepEqual(resolveChat(chats, "st0x-core-team"), {
    id: -100,
    title: "St0x Core Team",
  })
  assert.equal(resolveChat(chats, "st0x core"), undefined)
  assert.deepEqual(knownChatNames(chats), ["lab", "st0x-core-team"])
})
