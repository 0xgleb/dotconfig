import assert from "node:assert/strict"
import test from "node:test"

type ProviderCallStateModule = typeof import("./provider-call-state.ts")

const loadStateModule = async (): Promise<
  ProviderCallStateModule | undefined
> => import("./provider-call-state.ts").catch(() => undefined)

test("provider reservation payload carries the authenticated agent boundary", async () => {
  const state = await loadStateModule()
  assert.ok(state, "provider-call state boundary must exist")

  assert.deepEqual(
    state.providerCallReservationPayload({
      reservationId: "call-a",
      agentId: "session-a",
      cwd: "/Users/example/code/st0x",
      role: "general",
      requestedTokens: 42,
      lane: "human",
      ownerInteractionAt: 1_000,
    }),
    {
      reservationId: "call-a",
      agentId: "session-a",
      cwd: "/Users/example/code/st0x",
      role: "general",
      provider: "openai",
      requestedTokens: 42,
      lane: "human",
      ownerInteractionAt: 1_000,
    },
  )
})

test("autonomous OpenAI calls reserve once and unresolved overlap fails closed", async () => {
  const state = await loadStateModule()
  assert.ok(state, "provider-call state boundary must exist")

  assert.deepEqual(
    state.providerCallAction(undefined, "autonomous", "openai"),
    {
      action: "reserve",
    },
  )
  assert.deepEqual(
    state.providerCallAction(
      { reservationId: "call-a" },
      "autonomous",
      "openai-codex",
    ),
    { action: "block-unresolved" },
  )
  assert.deepEqual(
    state.providerCallAction(
      { reservationId: "call-a", actualTokens: 100 },
      "autonomous",
      "openai-codex",
    ),
    { action: "retry-settlement", reservationId: "call-a", actualTokens: 100 },
  )
})

test("every OpenAI lane is throttled and only other providers remain outside", async () => {
  const state = await loadStateModule()
  assert.ok(state, "provider-call state boundary must exist")

  assert.deepEqual(state.providerCallAction(undefined, "human", "openai"), {
    action: "reserve",
  })
  assert.deepEqual(
    state.providerCallAction(undefined, "responsive", "openai-codex"),
    { action: "reserve" },
  )
  assert.deepEqual(
    state.providerCallAction(undefined, "autonomous", "anthropic"),
    { action: "skip" },
  )
})

test("provider settlements reject malformed usage and preserve exact reservation identity", async () => {
  const state = await loadStateModule()
  assert.ok(state, "provider-call state boundary must exist")

  assert.deepEqual(
    state.providerCallSettlement(
      { reservationId: "call-a" },
      { provider: "openai-codex", totalTokens: 42 },
    ),
    { reservationId: "call-a", actualTokens: 42 },
  )
  assert.equal(
    state.providerCallSettlement(
      { reservationId: "call-a" },
      { provider: "openai-codex", totalTokens: -1 },
    ),
    undefined,
  )
  assert.equal(
    state.providerCallSettlement(
      { reservationId: "call-a" },
      { provider: "anthropic", totalTokens: 42 },
    ),
    undefined,
  )
})
