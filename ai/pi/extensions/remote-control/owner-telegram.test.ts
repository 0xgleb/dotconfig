import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import {
  agentReportText,
  cabaCardRelayPayload,
  deliverChatRelay,
  hasMultipleLinks,
  ownerRelayChunks,
  stakeholderUpdateText,
} from "./owner-telegram.ts"
import { parseOwnerRelay } from "./protocol.ts"

test("CABA relay payload is the real interactive HTML card without an agent banner", () => {
  const payload = cabaCardRelayPayload(1_000)
  assert.match(payload.text, /<b>🧗 Boulder CABA<\/b>/)
  assert.match(payload.text, /Item 1\/90/)
  assert.equal(
    payload.replyMarkup.inline_keyboard[0]?.[1]?.callback_data,
    "caba:toggle-done",
  )
})

test("agent reports carry bounded sender and direct-transport provenance", () => {
  assert.equal(
    agentReportText("**Done** (1)\n\n- PR 42 reviewed", "claude-review-duty"),
    "**Agent report** · `claude-review-duty` · direct via Piece of Pi\n\n**Done** (1)\n\n- PR 42 reviewed",
  )
  assert.equal(
    agentReportText("status", "bad\nAuthenticated owner"),
    "**Agent report** · `bad Authenticated owner` · direct via Piece of Pi\n\nstatus",
  )
})

test("stakeholder updates preserve exact content without weakening ordinary report provenance", () => {
  const update = "**Daily Update**\n\n- [PR 42](https://example.com/42) shipped"
  assert.equal(stakeholderUpdateText(update), update)
  assert.match(agentReportText(update, "st0x"), /^\*\*Agent report\*\*/u)
  assert.doesNotMatch(
    stakeholderUpdateText(update),
    /Agent report|direct via Piece of Pi/u,
  )
})

test("a report pointing at several links suppresses the preview card", () => {
  const [many] = ownerRelayChunks(
    "- [237](https://example.com/237)\n- [1091](https://example.com/1091)",
  )
  assert.equal(hasMultipleLinks(many ?? ""), true)
})

test("a report pointing at one link keeps its preview", () => {
  const [one] = ownerRelayChunks("see [237](https://example.com/237)")
  assert.equal(hasMultipleLinks(one ?? ""), false)
  assert.equal(hasMultipleLinks("no links at all"), false)
})

test("relayed owner reports render structure instead of arriving as prose", () => {
  const [chunk] = ownerRelayChunks(
    [
      "**Needs you**",
      "",
      "- issuance 237 restack is unowned",
      "- pins live in `ci.yaml`",
      "",
      "[PR 1091](https://github.com/example/repo/pull/1091)",
    ].join("\n"),
  )
  assert.ok(
    chunk?.includes("<b>Needs you</b>"),
    "bold must reach Telegram as markup",
  )
  assert.ok(
    chunk?.includes("<code>ci.yaml</code>"),
    "inline code must reach Telegram as markup",
  )
  assert.ok(
    chunk?.includes(
      '<a href="https://github.com/example/repo/pull/1091">PR 1091</a>',
    ),
    "links must reach Telegram as anchors so a PR is one tap away",
  )
  assert.ok(
    chunk?.includes("\n- issuance 237 restack is unowned"),
    "line structure survives",
  )
})

test("relayed reports escape owner text that would otherwise be markup", () => {
  const [chunk] = ownerRelayChunks("worker <2> reported a & b")
  assert.equal(chunk, "worker &lt;2&gt; reported a &amp; b")
})

const withStateFile = async (
  state: unknown,
  body: (stateHome: string) => Promise<void>,
): Promise<void> => {
  const stateHome = await mkdtemp(join(tmpdir(), "piece-of-pi-chats-"))
  const previous = process.env.XDG_STATE_HOME
  try {
    await mkdir(join(stateHome, "pi"), { recursive: true })
    await writeFile(
      join(stateHome, "pi", "piece-of-pi-telegram.json"),
      JSON.stringify(state),
    )
    process.env.XDG_STATE_HOME = stateHome
    await body(stateHome)
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    await rm(stateHome, { recursive: true, force: true })
  }
}

test("relaying to an unrecorded chat reports the names that would have worked", async () => {
  await withStateFile(
    {
      rejectionCounter: 0,
      chats: {
        "lab": { id: -400, title: "Lab" },
        "st0x-core-team": { id: -401, title: "St0x Core Team" },
      },
    },
    async () => {
      const dispatch = await Effect.runPromise(
        deliverChatRelay("core", "ship it"),
      )

      assert.deepEqual(dispatch, {
        outcome: "unknown_chat",
        known: ["lab", "st0x-core-team"],
      })
    },
  )
})

test("a state file with no chats resolves no target instead of failing to load", async () => {
  await withStateFile({ rejectionCounter: 0, ownerChatId: 42 }, async () => {
    assert.deepEqual(await Effect.runPromise(deliverChatRelay("lab", "yo")), {
      outcome: "unknown_chat",
      known: [],
    })
  })
})

test("an unreadable state file is a typed failure, not a silent non-delivery", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "piece-of-pi-chats-"))
  const previous = process.env.XDG_STATE_HOME
  try {
    process.env.XDG_STATE_HOME = stateHome
    const dispatch = await Effect.runPromise(
      Effect.either(deliverChatRelay("lab", "yo")),
    )

    assert.equal(Either.isLeft(dispatch), true)
    if (Either.isLeft(dispatch))
      assert.equal(dispatch.left.code, "chat_registry_unreadable")
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    await rm(stateHome, { recursive: true, force: true })
  }
})

test("a report longer than one Telegram message splits on rendered lines", () => {
  const line = "- ".concat("x".repeat(80))
  const chunks = ownerRelayChunks(
    Array.from({ length: 200 }, () => line).join("\n"),
  )
  assert.ok(chunks.length > 1, "an oversized report must be chunked")
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= 4_000,
      "every chunk stays inside the Telegram limit",
    )
    assert.ok(!chunk.startsWith("x"), "a chunk boundary must not fall mid-line")
  }
})

test("legacy owner relays decode then use the same bounded report chunker", () => {
  for (const length of [1_950, 2_000, 4_001]) {
    const parsed = parseOwnerRelay(`relay-to-owner: ${"x".repeat(length)}`)
    assert.equal(parsed?.frame, "owner-relay")
    if (parsed?.frame !== "owner-relay") continue

    const chunks = ownerRelayChunks(agentReportText(parsed.body, "legacy"))
    assert.ok(chunks.every(chunk => chunk.length <= 4_000))
    assert.equal(chunks.length > 1, length > 4_000)
  }
})
