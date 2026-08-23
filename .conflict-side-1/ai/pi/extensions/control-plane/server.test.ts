import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { Effect, Either } from "effect"
import type { RegistryStore } from "../agent-registry/registry.ts"
import type { RemoteBridgeStore } from "../remote-control/sqlite-store.ts"
import { startControlPlaneServer } from "./server.ts"
import { makeSqliteJobStore, type SqliteJobStore } from "./sqlite-job-store.ts"

const withServer = async (
  run: (origin: string, store: SqliteJobStore) => Promise<void>,
  options: { readonly bridgeStore?: RemoteBridgeStore } = {},
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-http-test-"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite")),
  )
  const registryStore = {
    snapshot: () =>
      Effect.succeed({
        version: 1 as const,
        agents: [],
        leases: [],
        requests: [],
      }),
  } as unknown as RegistryStore
  const server = await Effect.runPromise(
    startControlPlaneServer({
      host: "127.0.0.1",
      port: 0,
      store,
      registryStore,
      ...(options.bridgeStore ? { bridgeStore: options.bridgeStore } : {}),
    }),
  )
  try {
    await run(server.origin, store)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

const enqueueBody = {
  kind: "review-duty.scan",
  payload: { profile: "st0x-review" },
  runAt: 1_000,
  maxAttempts: 3,
  recurrence: {
    baseMs: 2 * 60 * 60 * 1_000,
    jitterMs: 60 * 60 * 1_000,
  },
  idempotencyKey: "review-duty:st0x-review",
}

const harnessHeadSha = "a".repeat(40)
const harnessEnqueueBody = {
  kind: "harness.review",
  payload: {
    lane: "claude-code-max",
    task: "review-loop",
    profile: "personal-review",
    repository: "0xgleb/example",
    pullRequest: 7,
    kind: "own",
    inputHeadSha: harnessHeadSha,
    repositoryRoot: "/Users/example/code/0xgleb/example",
    isolation: "approved-worktree",
  },
  runAt: 0,
  maxAttempts: 2,
  idempotencyKey: "harness:personal:example:7:head",
}

test("the server refuses non-loopback bind addresses", async () => {
  const result = await Effect.runPromise(
    Effect.either(
      startControlPlaneServer({
        host: "0.0.0.0",
        port: 0,
        store: {} as SqliteJobStore,
      }),
    ),
  )
  assert.ok(Either.isLeft(result))
  if (Either.isRight(result)) assert.fail("expected bind rejection")
  assert.equal(result.left.code, "invalid_bind")
})

test("health and read-only job routes return bounded versioned JSON", async () =>
  withServer(async origin => {
    const health = await fetch(`${origin}/v1/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      status: "ok",
      protocolVersion: 1,
      schemaVersion: 6,
    })

    const jobs = await fetch(`${origin}/v1/jobs`)
    assert.equal(jobs.status, 200)
    assert.deepEqual(await jobs.json(), { jobs: [] })

    const agents = await fetch(`${origin}/v1/agents`)
    assert.equal(agents.status, 200)
    assert.deepEqual(await agents.json(), { agents: [] })

    const usage = await fetch(`${origin}/v1/usage`)
    assert.equal(usage.status, 200)
    const usageBody = (await usage.json()) as {
      samples: unknown[]
      checkpoints: unknown[]
      sampling: { status: string }
    }
    assert.deepEqual(usageBody.samples, [])
    assert.deepEqual(usageBody.checkpoints, [])
    assert.ok(["sampling", "ok"].includes(usageBody.sampling.status))

    const usageStatus = await fetch(`${origin}/v1/usage/status`)
    assert.equal(usageStatus.status, 200)
    const statusBody = (await usageStatus.json()) as {
      sampling: { allowance: { status: string } }
    }
    assert.equal(statusBody.sampling.allowance.status, "unavailable")
  }))

test("bridge heartbeats remain unverified endpoints even when their ID names a managed pane", async () => {
  const bridgeStore = {
    listAgents: () =>
      Effect.succeed([
        {
          id: "claude-review-duty",
          label: "Claude Code · review duty",
          cwd: "/Users/example/code/dataclique",
          accepting: true,
          heartbeatAt: 1_000,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        {
          id: "legacy-external-heartbeat",
          label: "legacy external heartbeat",
          cwd: "/Users/example/code/dataclique/yielduck",
          accepting: true,
          heartbeatAt: 1_000,
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      ]),
  } as unknown as RemoteBridgeStore

  await withServer(
    async origin => {
      const response = await fetch(`${origin}/v1/agents`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as {
        agents: { id: string; presence: string }[]
      }
      assert.deepEqual(
        body.agents.map(({ id, presence }) => ({ id, presence })),
        [
          { id: "claude-review-duty", presence: "bridge-endpoint" },
          { id: "legacy-external-heartbeat", presence: "bridge-endpoint" },
        ],
      )
    },
    { bridgeStore },
  )
})

test("autonomous admission is role-paced when allowance evidence is absent", async () =>
  withServer(async origin => {
    const first = await fetch(
      `${origin}/v1/usage/admit?role=moneymentum-operator`,
      { method: "POST" },
    )
    assert.equal(first.status, 200)
    const firstBody = (await first.json()) as {
      admission: {
        allowed: boolean
        policy: {
          pace: string
          rolePolling: { role: string; effectiveIntervalMs: number }
        }
      }
    }
    assert.equal(firstBody.admission.allowed, true)
    assert.equal(firstBody.admission.policy.pace, "unverified")
    assert.equal(
      firstBody.admission.policy.rolePolling.role,
      "moneymentum-operator",
    )
    assert.equal(
      firstBody.admission.policy.rolePolling.effectiveIntervalMs,
      16 * 60 * 60 * 1_000,
    )

    const second = await fetch(
      `${origin}/v1/usage/admit?role=moneymentum-operator`,
      { method: "POST" },
    )
    assert.equal(second.status, 200)
    const secondBody = (await second.json()) as {
      admission: { allowed: boolean; retryAt?: number }
    }
    assert.equal(secondBody.admission.allowed, false)
    assert.equal(typeof secondBody.admission.retryAt, "number")

    const workflow = await fetch(
      `${origin}/v1/usage/admit?role=reviewer&kind=workflow&requestedTokens=800000`,
      { method: "POST" },
    )
    assert.equal(workflow.status, 200)
    const workflowBody = (await workflow.json()) as {
      admission: {
        allowed: boolean
        grantedTokens?: number
        policy: { throttleRatio: number }
      }
    }
    assert.equal(workflowBody.admission.allowed, true)
    assert.equal(workflowBody.admission.grantedTokens, 200_000)
    assert.equal(workflowBody.admission.policy.throttleRatio, 0.25)

    const malformedWorkflow = await fetch(
      `${origin}/v1/usage/admit?role=reviewer&kind=workflow&requestedTokens=3999`,
      { method: "POST" },
    )
    assert.equal(malformedWorkflow.status, 400)

    const malformed = await fetch(`${origin}/v1/usage/admit?role=not-a-role`, {
      method: "POST",
    })
    assert.equal(malformed.status, 400)
  }))

test("allowance checkpoints accept only typed bounded writes", async () =>
  withServer(async origin => {
    const checkpoint = {
      provider: "openai",
      pool: "chatgpt-shared-weekly",
      source: "manual",
      capturedAt: Date.now(),
      remainingPercent: 25,
      resetAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
    }
    const recorded = await fetch(`${origin}/v1/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkpoint),
    })
    assert.equal(recorded.status, 201)
    assert.deepEqual(await recorded.json(), { checkpoint })

    const usage = await fetch(`${origin}/v1/usage`)
    const usageBody = (await usage.json()) as { checkpoints: unknown[] }
    assert.deepEqual(usageBody.checkpoints, [checkpoint])

    const rejected = await fetch(`${origin}/v1/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...checkpoint, remainingPercent: 201 }),
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(await rejected.json(), {
      error: { code: "invalid_input", message: "request input is invalid" },
    })

    const spoofedPool = await fetch(`${origin}/v1/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...checkpoint, provider: "anthropic" }),
    })
    assert.equal(spoofedPool.status, 400)

    const legacyShape = await fetch(`${origin}/v1/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capturedAt: checkpoint.capturedAt + 1,
        remainingPercent: 24,
        resetAt: checkpoint.resetAt,
      }),
    })
    assert.equal(legacyShape.status, 400)
  }))

test("owner-verified refill checkpoints preserve an unknown reset boundary", async () =>
  withServer(async origin => {
    const checkpoint = {
      provider: "openai",
      pool: "chatgpt-shared-weekly",
      source: "manual",
      capturedAt: Date.now() - 60_000,
      remainingPercent: 100,
      event: "refill",
    }
    const recorded = await fetch(`${origin}/v1/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkpoint),
    })
    assert.equal(recorded.status, 201)
    assert.deepEqual(await recorded.json(), { checkpoint })

    const usage = await fetch(`${origin}/v1/usage`)
    const body = (await usage.json()) as { checkpoints: unknown[] }
    assert.deepEqual(body.checkpoints, [checkpoint])
  }))

test("authenticated relay records the intervention against the target agent", async () =>
  withServer(async (origin, store) => {
    const ownerInteractionAt = Date.now()
    const response = await fetch(`${origin}/v1/usage/interventions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetAgentId: "target-agent",
        targetCwd: "/Users/example/code/st0x",
        ownerInteractionAt,
      }),
    })

    assert.equal(response.status, 200)
    assert.equal(
      await Effect.runPromise(store.agentIntervention("target-agent")),
      ownerInteractionAt,
    )
  }))

test("agent-scoped throttle control reports the current decayed allocation", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    await Effect.runPromise(
      store.recordAgentIntervention({
        agentId: "st0x-agent",
        cwd: "/Users/example/code/st0x",
        ownerInteractionAt: now - 2 * 60 * 60 * 1_000,
      }),
    )
    const parameters = new URLSearchParams({
      agentId: "st0x-agent",
      cwd: "/Users/example/code/st0x",
    })
    const response = await fetch(`${origin}/v1/usage/control?${parameters}`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      allocation?: {
        configuredWeight: number
        recencyFactor: number
        effectiveWeight: number
      }
    }

    assert.equal(body.allocation?.configuredWeight, 2)
    assert.ok((body.allocation?.recencyFactor ?? 0) > 0.62)
    assert.ok((body.allocation?.recencyFactor ?? 1) < 0.63)
    assert.ok((body.allocation?.effectiveWeight ?? 0) > 1.24)
    assert.ok((body.allocation?.effectiveWeight ?? 2) < 1.26)
  }))

test("fresh Codex provider allowance drives reservations without replacing stale shared-pool history", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const resetAt = now + 4 * 24 * 60 * 60 * 1_000
    for (const checkpoint of [
      {
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: now - 3 * 24 * 60 * 60 * 1_000,
        remainingPercent: 81,
        resetAt,
      },
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: now - 12 * 60 * 60 * 1_000,
        remainingPercent: 60,
        resetAt,
      },
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: now - 1,
        remainingPercent: 44,
        resetAt,
      },
    ] as const)
      await Effect.runPromise(store.recordAllowanceCheckpoint(checkpoint))

    const insertUsage = store.unsafeDatabaseForTests.prepare(
      `INSERT INTO usage_samples (
         agent_id, captured_at, label, cwd, model,
         usage_input, usage_output, usage_cache_read, usage_cache_write,
         usage_total
       ) VALUES (?, ?, 'agent', '/tmp/project', 'openai-codex/gpt-5.6-sol',
                 0, 0, 0, 0, ?)`,
    )
    insertUsage.run("agent-a", now - 12 * 60 * 60 * 1_000, 0)
    insertUsage.run("agent-a", now - 1, 1_000_000)

    const workflowAdmission = await fetch(
      `${origin}/v1/usage/admit?role=general&kind=workflow&requestedTokens=100000`,
      { method: "POST" },
    )
    assert.equal(workflowAdmission.status, 200)
    const workflowBody = (await workflowAdmission.json()) as {
      admission: {
        policy?: { actualRemainingPercent?: number; pace?: string }
      }
    }
    assert.equal(workflowBody.admission.policy?.actualRemainingPercent, 44)
    assert.notEqual(workflowBody.admission.policy?.pace, "unverified")

    const response = await fetch(`${origin}/v1/usage/provider-calls/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reservationId: "provider-current",
        agentId: "test-agent",
        cwd: "/tmp/project",
        role: "general",
        provider: "openai",
        requestedTokens: 1_000,
        lane: "autonomous",
        ownerInteractionAt: null,
      }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    const body = (await response.json()) as {
      policy: {
        pace: string
        actualRemainingPercent?: number
        observedBurnPercentPerHour?: number
      }
      providerBudget: {
        calibration?: { observedBurnPercent: number }
      }
    }
    assert.equal(body.policy.actualRemainingPercent, 44)
    assert.notEqual(body.policy.pace, "unverified")
    assert.ok((body.policy.observedBurnPercentPerHour ?? 0) > 0)
    assert.equal(body.providerBudget.calibration?.observedBurnPercent, 16)

    const usage = (await (await fetch(`${origin}/v1/usage`)).json()) as {
      checkpoints: Array<{ pool: string }>
      control?: {
        computedAt: number
        provider: string
        pool: string
        source: string
        profile: { kind: string; participants: number }
        policy: {
          actualRemainingPercent?: number
          pace: string
          throttleRatio: number
          observedBurnPercentPerHour?: number
          permittedBurnPercentPerHour?: number
        }
        providerBudget?: {
          capacityTokens: number
          permittedTokensPerHour: number
          windowMs: number
        }
        roles: Array<{ role: string; tokenScale: number }>
        activity: {
          inFlightCalls: number
          reservedTokens: number
          counts: { admitted: number; deferred: number; scaled: number }
          latest?: {
            at: number
            kind: string
            outcome: string
            role: string
            requestedTokens?: number
            grantedTokens?: number
          }
        }
      }
    }
    assert.deepEqual(
      new Set(usage.checkpoints.map(checkpoint => checkpoint.pool)),
      new Set(["chatgpt-shared-weekly", "codex-app-server-weekly"]),
    )
    assert.ok((usage.control?.computedAt ?? 0) > 0)
    assert.equal(usage.control?.provider, "openai")
    assert.equal(usage.control?.pool, "codex-app-server-weekly")
    assert.equal(usage.control?.source, "codex-app-server")
    assert.deepEqual(usage.control?.profile, {
      kind: "flat-until-reset",
      participants: 1,
    })
    assert.equal(usage.control?.policy.actualRemainingPercent, 44)
    assert.equal(usage.control?.policy.pace, "critical")
    assert.ok((usage.control?.policy.throttleRatio ?? 0) > 0)
    assert.ok((usage.control?.policy.throttleRatio ?? 1) < 1)
    assert.ok((usage.control?.providerBudget?.capacityTokens ?? 0) > 0)
    assert.deepEqual(
      usage.control?.roles.map(({ role }) => role),
      ["general", "reviewer", "yielduck-operator", "moneymentum-operator"],
    )
    assert.equal(usage.control?.activity.inFlightCalls, 1)
    assert.equal(usage.control?.activity.reservedTokens, 1_000)
    assert.equal(usage.control?.activity.counts.admitted, 1)
    assert.equal(usage.control?.activity.counts.scaled, 1)
    assert.deepEqual(usage.control?.activity.latest, {
      at: usage.control?.activity.latest?.at,
      kind: "provider-call",
      outcome: "admitted",
      role: "general",
      requestedTokens: 1_000,
      grantedTokens: 1_000,
    })

    const controlResponse = await fetch(`${origin}/v1/usage/control`)
    assert.equal(controlResponse.status, 200)
    const control = (await controlResponse.json()) as typeof usage.control
    assert.equal(control?.pool, usage.control?.pool)
    assert.equal(
      control?.policy.actualRemainingPercent,
      usage.control?.policy.actualRemainingPercent,
    )
    assert.deepEqual(
      control?.roles.map(({ role }) => role),
      usage.control?.roles.map(({ role }) => role),
    )
  }))

test("fresh manual Codex aggregate overrides newer single-account provider evidence", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const resetAt = now + 6 * 24 * 60 * 60 * 1_000
    await Effect.runPromise(
      store.recordAllowanceCheckpoint({
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "manual",
        capturedAt: now - 2_000,
        remainingPercent: 113,
        resetAt,
      }),
    )
    await Effect.runPromise(
      store.recordAllowanceCheckpoint({
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: now - 1_000,
        remainingPercent: 100,
        resetAt,
      }),
    )

    const control = (await (
      await fetch(`${origin}/v1/usage/control`)
    ).json()) as {
      pool: string
      source: string
      policy: { actualRemainingPercent?: number }
    }
    assert.equal(control.pool, "codex-app-server-weekly")
    assert.equal(control.source, "manual")
    assert.equal(control.policy.actualRemainingPercent, 113)
  }))

test("stale manual Codex aggregate cannot override fresh provider evidence", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const resetAt = now + 6 * 24 * 60 * 60 * 1_000
    await Effect.runPromise(
      store.recordAllowanceCheckpoint({
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "manual",
        capturedAt: now - 13 * 60 * 60 * 1_000,
        remainingPercent: 113,
        resetAt,
      }),
    )
    await Effect.runPromise(
      store.recordAllowanceCheckpoint({
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: now - 1_000,
        remainingPercent: 100,
        resetAt,
      }),
    )

    const control = (await (
      await fetch(`${origin}/v1/usage/control`)
    ).json()) as {
      source: string
      policy: { actualRemainingPercent?: number }
    }
    assert.equal(control.source, "codex-app-server")
    assert.equal(control.policy.actualRemainingPercent, 100)
  }))

test("open uncalibrated provider calls use policy cadence instead of role polling cadence", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const resetAt = now + 6 * 24 * 60 * 60 * 1_000
    for (const capturedAt of [now - 10 * 60 * 1_000, now - 1])
      await Effect.runPromise(
        store.recordAllowanceCheckpoint({
          provider: "openai",
          pool: "codex-app-server-weekly",
          source: "codex-app-server",
          capturedAt,
          remainingPercent: 100,
          resetAt,
        }),
      )
    const reserve = async (reservationId: string) =>
      (await (
        await fetch(`${origin}/v1/usage/provider-calls/reserve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reservationId,
            agentId: "test-agent",
            cwd: "/tmp/project",
            role: "reviewer",
            provider: "openai",
            requestedTokens: 1_000,
            lane: "autonomous",
            ownerInteractionAt: null,
          }),
        })
      ).json()) as {
        reservation:
          | { allowed: true; reservationId: string }
          | { allowed: false; retryAt: number }
      }

    const first = await reserve("uncalibrated-first")
    assert.equal(first.reservation.allowed, true)
    if (!first.reservation.allowed)
      return assert.fail("first call must be admitted")
    const settled = await fetch(`${origin}/v1/usage/provider-calls/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reservationId: first.reservation.reservationId,
        actualTokens: 1_000,
      }),
    })
    assert.equal(settled.status, 200)

    const second = await reserve("uncalibrated-second")
    assert.equal(second.reservation.allowed, false)
    if (second.reservation.allowed)
      return assert.fail(
        "immediate second call must observe the minimum interval",
      )
    assert.ok(second.reservation.retryAt <= Date.now() + 5_000)
  }))

test("calibrated open policy still drips provider work continuously", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const start = now - 12 * 60 * 60 * 1_000
    const resetAt = now + 4 * 24 * 60 * 60 * 1_000
    for (const checkpoint of [
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: start,
        remainingPercent: 100,
        resetAt,
      },
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: now - 1,
        remainingPercent: 99,
        resetAt,
      },
    ] as const)
      await Effect.runPromise(store.recordAllowanceCheckpoint(checkpoint))

    const insertUsage = store.unsafeDatabaseForTests.prepare(
      `INSERT INTO usage_samples (
         agent_id, captured_at, label, cwd, model,
         usage_input, usage_output, usage_cache_read, usage_cache_write,
         usage_total
       ) VALUES (?, ?, 'agent', '/tmp/project', 'openai-codex/gpt-5.6-sol',
                 0, 0, 0, 0, ?)`,
    )
    insertUsage.run("agent-a", start, 0)
    insertUsage.run("agent-a", now - 1, 1_000_000)

    const reserve = async (reservationId: string) =>
      (await (
        await fetch(`${origin}/v1/usage/provider-calls/reserve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reservationId,
            agentId: "test-agent",
            cwd: "/tmp/project",
            role: "general",
            provider: "openai",
            requestedTokens: 100_000,
            lane: "autonomous",
            ownerInteractionAt: null,
          }),
        })
      ).json()) as {
        reservation:
          | { allowed: true; reservationId: string }
          | { allowed: false; retryAt: number }
      }

    const first = await reserve("open-calibrated-first")
    assert.equal(first.reservation.allowed, true)
    if (!first.reservation.allowed)
      return assert.fail("first call must be admitted")
    await fetch(`${origin}/v1/usage/provider-calls/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reservationId: first.reservation.reservationId,
        actualTokens: 100_000,
      }),
    })

    const second = await reserve("open-calibrated-second")
    assert.equal(second.reservation.allowed, false)
    if (second.reservation.allowed)
      return assert.fail("calibrated open work must remain paced")
    assert.ok(second.reservation.retryAt > Date.now() + 60_000)
  }))

test("combined-account Codex allowance remains inside fleet pacing", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const resetAt = now + 4 * 24 * 60 * 60 * 1_000
    for (const checkpoint of [
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "manual",
        capturedAt: now - 2 * 60 * 60 * 1_000,
        remainingPercent: 105,
        resetAt,
      },
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "manual",
        capturedAt: now - 60 * 60 * 1_000,
        remainingPercent: 100,
        resetAt,
      },
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "manual",
        capturedAt: now - 1,
        remainingPercent: 113,
        resetAt,
      },
    ] as const)
      await Effect.runPromise(store.recordAllowanceCheckpoint(checkpoint))
    for (const sample of [
      {
        capturedAt: now - 2 * 60 * 60 * 1_000,
        agent: {
          identity: {
            id: "reviewer",
            pid: 1,
            model: "openai-codex/gpt-5.6-terra",
          },
          label: "reviewer",
          cwd: "/tmp/project",
          usage: {
            input: 970,
            output: 10,
            cacheRead: 20,
            cacheWrite: 0,
            totalTokens: 1_000,
          },
          heartbeatAt: now - 2 * 60 * 60 * 1_000,
          expiresAt: now + 60_000,
        },
      },
      {
        capturedAt: now - 60 * 60 * 1_000,
        agent: {
          identity: {
            id: "reviewer",
            pid: 1,
            model: "openai-codex/gpt-5.6-terra",
          },
          label: "reviewer",
          cwd: "/tmp/project",
          usage: {
            input: 150_000_000,
            output: 14_000_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 164_000_000,
          },
          heartbeatAt: now - 60 * 60 * 1_000,
          expiresAt: now + 60_000,
        },
      },
    ])
      await Effect.runPromise(
        store.recordUsage([sample.agent], sample.capturedAt),
      )
    const reserve = async (reservationId: string) =>
      (await (
        await fetch(`${origin}/v1/usage/provider-calls/reserve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reservationId,
            agentId: "test-agent",
            cwd: "/tmp/project",
            role: "reviewer",
            provider: "openai",
            requestedTokens: 100_000,
            lane: "autonomous",
            ownerInteractionAt: null,
          }),
        })
      ).json()) as {
        reservation:
          | { allowed: true; reservationId: string }
          | { allowed: false; retryAt: number }
      }

    const first = await reserve("combined-first")
    assert.equal(first.reservation.allowed, true)
    if (!first.reservation.allowed)
      return assert.fail("first call must be admitted")
    const settled = await fetch(`${origin}/v1/usage/provider-calls/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reservationId: first.reservation.reservationId,
        actualTokens: 100_000,
      }),
    })
    assert.equal(settled.status, 200)

    await delay(1_250)
    const second = await reserve("combined-second")
    assert.equal(second.reservation.allowed, false)
  }))

test("throttle control reports actual workflow enforcement decisions", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const resetAt = now + 4 * 24 * 60 * 60 * 1_000
    for (const checkpoint of [
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: now - 60 * 60 * 1_000,
        remainingPercent: 50,
        resetAt,
      },
      {
        provider: "openai",
        pool: "codex-app-server-weekly",
        source: "codex-app-server",
        capturedAt: now - 1,
        remainingPercent: 48,
        resetAt,
      },
    ] as const)
      await Effect.runPromise(store.recordAllowanceCheckpoint(checkpoint))

    const admission = await fetch(
      `${origin}/v1/usage/admit?role=reviewer&kind=workflow&requestedTokens=800000`,
      { method: "POST" },
    )
    assert.equal(admission.status, 200)
    const admitted = (await admission.json()) as {
      admission: { allowed: boolean; grantedTokens?: number }
    }
    assert.equal(admitted.admission.allowed, true)
    assert.ok((admitted.admission.grantedTokens ?? 800_000) < 800_000)

    const control = (await (
      await fetch(`${origin}/v1/usage/control`)
    ).json()) as {
      activity: {
        inFlightCalls: number
        counts: { scaled: number }
        latest?: {
          kind: string
          outcome: string
          role: string
          requestedTokens?: number
          grantedTokens?: number
        }
      }
    }
    assert.equal(control.activity.inFlightCalls, 0)
    assert.equal(control.activity.counts.scaled, 1)
    assert.deepEqual(control.activity.latest, {
      at: (control.activity.latest as { at?: number } | undefined)?.at,
      kind: "workflow",
      outcome: "scaled",
      role: "reviewer",
      requestedTokens: 800_000,
      grantedTokens: admitted.admission.grantedTokens,
    })
  }))

test("provider-call reservations serialize token spend and settlements are idempotent", async () =>
  withServer(async (origin, store) => {
    const now = Date.now()
    const start = now - 12 * 60 * 60 * 1_000
    const resetAt = now + 6 * 24 * 60 * 60 * 1_000
    for (const checkpoint of [
      {
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: start,
        remainingPercent: 100,
        resetAt,
      },
      {
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: now - 1,
        remainingPercent: 90,
        resetAt,
      },
    ] as const)
      await Effect.runPromise(store.recordAllowanceCheckpoint(checkpoint))

    const insertUsage = store.unsafeDatabaseForTests.prepare(
      `INSERT INTO usage_samples (
         agent_id, captured_at, label, cwd, model,
         usage_input, usage_output, usage_cache_read, usage_cache_write,
         usage_total
       ) VALUES (?, ?, 'agent', '/tmp/project', 'openai-codex/gpt-5.6-sol',
                 0, 0, 0, 0, ?)`,
    )
    insertUsage.run("agent-a", start, 0)
    insertUsage.run("agent-a", now - 1, 1_000_000)

    const reserve = (reservationId: string, requestedTokens: number) =>
      fetch(`${origin}/v1/usage/provider-calls/reserve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reservationId,
          agentId: "test-agent",
          cwd: "/tmp/project",
          role: "general",
          provider: "openai",
          requestedTokens,
          lane: "autonomous",
          ownerInteractionAt: null,
        }),
      })
    const [first, second] = await Promise.all([
      reserve("call-a", 200_000),
      reserve("call-b", 200_000),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const admissions = await Promise.all([first.json(), second.json()])
    const providerBudget = (
      admissions[0] as {
        providerBudget: {
          capacityTokens: number
          calibration: { tokensPerPercent: number }
        }
      }
    ).providerBudget
    assert.equal(providerBudget.calibration.tokensPerPercent, 100_000)
    assert.ok(providerBudget.capacityTokens > 200_000)
    assert.ok(providerBudget.capacityTokens < 300_000)
    assert.equal(
      admissions.filter(
        body =>
          (body as { reservation: { allowed: boolean } }).reservation.allowed,
      ).length,
      1,
    )

    const admitted = admissions.find(
      body =>
        (body as { reservation: { allowed: boolean } }).reservation.allowed,
    ) as { reservation: { reservationId: string } }
    const settle = (actualTokens: number) =>
      fetch(`${origin}/v1/usage/provider-calls/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reservationId: admitted.reservation.reservationId,
          actualTokens,
        }),
      })
    assert.equal((await settle(100_000)).status, 200)
    assert.equal((await settle(100_000)).status, 200)
    assert.equal((await settle(100_001)).status, 409)

    const unknown = await fetch(`${origin}/v1/usage/provider-calls/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reservationId: "unknown", actualTokens: 1 }),
    })
    assert.equal(unknown.status, 404)
  }))

test("hard reserve blocks autonomous turns and workflow fan-out before provider spend", async () =>
  withServer(async origin => {
    const now = Date.now()
    const resetAt = now + 5 * 24 * 60 * 60 * 1_000
    for (const checkpoint of [
      {
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: now - 30 * 60 * 1_000,
        remainingPercent: 7,
        resetAt,
      },
      {
        provider: "openai",
        pool: "chatgpt-shared-weekly",
        source: "manual",
        capturedAt: now - 1,
        remainingPercent: 5,
        resetAt,
      },
    ]) {
      const recorded = await fetch(`${origin}/v1/usage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkpoint),
      })
      assert.equal(recorded.status, 201)
    }

    const turn = await fetch(
      `${origin}/v1/usage/admit?role=yielduck-operator`,
      { method: "POST" },
    )
    const turnBody = (await turn.json()) as {
      admission: { allowed: boolean; policy: { throttleRatio: number } }
    }
    assert.equal(turnBody.admission.allowed, false)
    assert.equal(turnBody.admission.policy.throttleRatio, 0)

    const workflow = await fetch(
      `${origin}/v1/usage/admit?role=yielduck-operator&kind=workflow&requestedTokens=800000`,
      { method: "POST" },
    )
    const workflowBody = (await workflow.json()) as {
      admission: { allowed: boolean; grantedTokens: number }
    }
    assert.equal(workflowBody.admission.allowed, false)
    assert.equal(workflowBody.admission.grantedTokens, 0)
  }))

test("registered enqueue is idempotent and unknown executable kinds fail closed", async () =>
  withServer(async origin => {
    const enqueue = async (body: unknown): Promise<Response> =>
      fetch(`${origin}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    const first = await enqueue(enqueueBody)
    assert.equal(first.status, 201)
    const firstJob = (await first.json()) as { job: { id: string } }

    const duplicate = await enqueue(enqueueBody)
    assert.equal(duplicate.status, 200)
    const duplicateJob = (await duplicate.json()) as { job: { id: string } }
    assert.equal(duplicateJob.job.id, firstJob.job.id)

    const rejected = await enqueue({
      ...enqueueBody,
      kind: "shell.run",
      payload: { command: "arbitrary command" },
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(await rejected.json(), {
      error: { code: "invalid_input", message: "job request is invalid" },
    })
  }))

test("research enqueue requires typed project or agentops support ownership", async () =>
  withServer(async origin => {
    const post = (payload: unknown, runAt = Date.now()): Promise<Response> =>
      fetch(`${origin}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "harness.research",
          payload,
          runAt,
          maxAttempts: 2,
        }),
      })
    const legacy = {
      lane: "subscription-plan",
      harness: "claude-plan",
      profile: "agentops-yielduck",
      project: "yielduck",
      task: "yielduck-portfolio-replay-attribution",
      repositoryRoot: "/Users/example/yielduck",
      isolation: "read-only",
    }
    assert.equal((await post(legacy)).status, 400)
    assert.equal(
      (
        await post({
          ...legacy,
          ownership: {
            kind: "project-domain",
            project: "yielduck",
            role: "agentops-yielduck",
          },
        })
      ).status,
      400,
    )
    const projectOwned = {
      ...legacy,
      profile: "yielduck-research",
      ownership: {
        kind: "project-domain",
        project: "yielduck",
        role: "yielduck-research",
      },
    }
    assert.equal((await post(projectOwned, 8)).status, 400)
    assert.equal((await post(projectOwned)).status, 201)
    assert.equal(
      (
        await post({
          ...legacy,
          task: "classifier-stale-evidence-diagnosis",
          ownership: {
            kind: "agentops-support",
            project: "yielduck",
            role: "agentops-yielduck",
            supportArea: "classifier",
          },
        })
      ).status,
      201,
    )
  }))

test("concurrent idempotent enqueue reports exactly one creation", async () => {
  const job = {
    id: "job-a",
    spec: enqueueBody,
    state: "ready",
    attempt: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  } as const
  let enqueueCount = 0
  let listCount = 0
  let releaseLists: (() => void) | undefined
  const listsReleased = new Promise<void>(resolve => {
    releaseLists = resolve
  })
  const store = {
    list: () =>
      Effect.promise(async () => {
        listCount += 1
        if (listCount === 2) releaseLists?.()
        await listsReleased
        return []
      }),
    enqueue: () =>
      Effect.sync(() => {
        const created = enqueueCount === 0
        enqueueCount += 1
        return { job, created }
      }),
  } as unknown as SqliteJobStore
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store }),
  )
  try {
    const enqueue = () =>
      fetch(`${server.origin}/v1/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(enqueueBody),
      })
    const responses = await Promise.all([enqueue(), enqueue()])
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 201])
    const jobs = await Promise.all(
      responses.map(
        response => response.json() as Promise<{ job: { id: string } }>,
      ),
    )
    assert.equal(jobs[0]?.job.id, jobs[1]?.job.id)
    assert.equal(
      listCount,
      0,
      "enqueue status must not depend on a list snapshot",
    )
  } finally {
    await Effect.runPromise(server.close)
  }
})

test("workers claim due jobs with server-issued leases and stale completion is fenced", async () =>
  withServer(async origin => {
    const due = { ...enqueueBody, runAt: Date.now() - 1_000 }
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(due),
    })
    const created = (await enqueued.json()) as { job: { id: string } }

    const claim = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "reviewer-a", ttlMs: 90_000 }),
    })
    assert.equal(claim.status, 200)
    const claimed = (await claim.json()) as {
      job: { id: string; leaseToken: string; state: string }
    }
    assert.equal(claimed.job.id, created.job.id)
    assert.equal(claimed.job.state, "leased")
    assert.match(claimed.job.leaseToken, /^[0-9a-f-]{36}$/)

    const noSecondJob = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "reviewer-b", ttlMs: 90_000 }),
    })
    assert.equal(noSecondJob.status, 204)

    const stale = await fetch(`${origin}/v1/jobs/${created.job.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseToken: "stale-token", summary: "done" }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      error: { code: "stale_lease", message: "job lease is stale" },
    })

    const complete = await fetch(
      `${origin}/v1/jobs/${created.job.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: claimed.job.leaseToken,
          summary: "review scan completed",
        }),
      },
    )
    assert.equal(complete.status, 200)
    assert.equal(
      ((await complete.json()) as { job: { state: string } }).job.state,
      "succeeded",
    )
  }))

test("harness jobs accept only a matching bounded typed handoff", async () =>
  withServer(async origin => {
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(harnessEnqueueBody),
    })
    const created = (await enqueued.json()) as { job: { id: string } }
    const claimedResponse = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "harness-supervisor", ttlMs: 90_000 }),
    })
    const claimed = (await claimedResponse.json()) as {
      job: { leaseToken: string; attempt: number }
    }
    const endpoint = `${origin}/v1/jobs/${created.job.id}/complete`

    const legacySummary = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: claimed.job.leaseToken,
        summary: "untyped",
      }),
    })
    assert.equal(legacySummary.status, 400)

    const mismatched = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: claimed.job.leaseToken,
        handoff: {
          protocolVersion: 1,
          jobId: created.job.id,
          attempt: claimed.job.attempt,
          lane: "claude-code-max",
          repository: "0xgleb/example",
          pullRequest: 7,
          inputHeadSha: "b".repeat(40),
          outputHeadSha: harnessHeadSha,
          status: "clean",
          assessment: "No verified findings.",
          evidence: ["check:review-core"],
          verifier: "fable-clean",
          executorProvenance: "subscription-verified",
        },
      }),
    })
    assert.equal(mismatched.status, 400)

    const complete = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: claimed.job.leaseToken,
        handoff: {
          protocolVersion: 1,
          jobId: created.job.id,
          attempt: claimed.job.attempt,
          lane: "claude-code-max",
          repository: "0xgleb/example",
          pullRequest: 7,
          inputHeadSha: harnessHeadSha,
          outputHeadSha: harnessHeadSha,
          status: "clean",
          assessment: "No verified findings.",
          evidence: ["check:review-core"],
          verifier: "fable-clean",
          executorProvenance: "subscription-verified",
        },
      }),
    })
    assert.equal(complete.status, 200)
    const completed = (await complete.json()) as {
      job: {
        state: string
        result?: { kind: string; handoff: { jobId: string } }
      }
    }
    assert.equal(completed.job.state, "succeeded")
    assert.equal(completed.job.result?.kind, "harness.review")
    assert.equal(completed.job.result?.handoff.jobId, created.job.id)

    const persisted = await fetch(`${origin}/v1/jobs`)
    assert.equal(persisted.status, 200)
    const persistedJobs = (await persisted.json()) as {
      jobs: Array<{ result?: { handoff: { jobId: string } } }>
    }
    assert.equal(persistedJobs.jobs[0]?.result?.handoff.jobId, created.job.id)
  }))

test("kind-filtered worker claims accept only registered bounded kinds", async () =>
  withServer(async origin => {
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...enqueueBody, runAt: 0 }),
    })
    assert.equal(enqueued.status, 201)

    const filtered = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "harness-supervisor",
        ttlMs: 90_000,
        kinds: ["harness.review"],
      }),
    })
    assert.equal(filtered.status, 204)

    for (const kinds of [
      [],
      ["unregistered.kind"],
      [42],
      ["harness.review", "harness.review"],
      Array.from({ length: 9 }, () => "harness.review"),
      "harness.review",
    ]) {
      const rejected = await fetch(`${origin}/v1/worker/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workerId: "harness-supervisor",
          ttlMs: 90_000,
          kinds,
        }),
      })
      assert.equal(rejected.status, 400)
    }

    const matching = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "review-supervisor",
        ttlMs: 90_000,
        kinds: ["review-duty.scan"],
      }),
    })
    assert.equal(matching.status, 200)
    const claimed = (await matching.json()) as {
      job: { spec: { kind: string } }
    }
    assert.equal(claimed.job.spec.kind, "review-duty.scan")
  }))

test("failed attempts retry through the fail route until attempts are exhausted", async () =>
  withServer(async origin => {
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(harnessEnqueueBody),
    })
    const created = (await enqueued.json()) as { job: { id: string } }
    const endpoint = `${origin}/v1/jobs/${created.job.id}/fail`

    const claim = async (): Promise<{ leaseToken: string }> => {
      const response = await fetch(`${origin}/v1/worker/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: "harness-supervisor", ttlMs: 90_000 }),
      })
      return ((await response.json()) as { job: { leaseToken: string } }).job
    }

    const first = await claim()
    const unknownFields = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: first.leaseToken,
        retryDelayMs: 0,
        summary: "executor failed",
        command: "rm -rf /",
      }),
    })
    assert.equal(unknownFields.status, 400)

    const stale = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: "not-the-lease",
        retryDelayMs: 0,
        summary: "executor failed",
      }),
    })
    assert.equal(stale.status, 409)

    const retried = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: first.leaseToken,
        retryDelayMs: 0,
        summary: "executor failed",
      }),
    })
    assert.equal(retried.status, 200)
    const retriedJob = (await retried.json()) as { job: { state: string } }
    assert.equal(retriedJob.job.state, "retry_wait")

    const second = await claim()
    const exhausted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: second.leaseToken,
        retryDelayMs: 0,
        summary: "executor failed again",
      }),
    })
    assert.equal(exhausted.status, 200)
    const exhaustedJob = (await exhausted.json()) as { job: { state: string } }
    assert.equal(exhaustedJob.job.state, "failed")
  }))

test("expired leases are recovered on the next worker claim", async () =>
  withServer(async origin => {
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(harnessEnqueueBody),
    })
    const created = (await enqueued.json()) as { job: { id: string } }

    const first = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-a", ttlMs: 1 }),
    })
    assert.equal(first.status, 200)

    await new Promise(resolve => setTimeout(resolve, 10))
    const second = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "worker-b", ttlMs: 90_000 }),
    })
    assert.equal(second.status, 200)
    const reclaimed = (await second.json()) as {
      job: { id: string; attempt: number }
    }
    assert.equal(reclaimed.job.id, created.job.id)
    assert.equal(reclaimed.job.attempt, 2)
  }))

test("worker boundaries reject unknown fields and client-supplied lease tokens", async () =>
  withServer(async origin => {
    const rejected = await fetch(`${origin}/v1/worker/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: "reviewer-a",
        ttlMs: 90_000,
        leaseToken: "caller-chosen",
      }),
    })
    assert.equal(rejected.status, 400)
  }))

test("oversized and malformed request bodies are rejected without enqueueing", async () =>
  withServer(async (origin, store) => {
    const oversized = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...enqueueBody, padding: "x".repeat(20_000) }),
    })
    assert.equal(oversized.status, 413)

    const malformed = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    })
    assert.equal(malformed.status, 400)
    assert.deepEqual(await Effect.runPromise(store.list()), [])
  }))

test("unknown routes and unsupported methods do not fall through", async () =>
  withServer(async origin => {
    assert.equal((await fetch(`${origin}/v1/unknown`)).status, 404)
    assert.equal(
      (
        await fetch(`${origin}/v1/jobs`, {
          method: "DELETE",
        })
      ).status,
      405,
    )
  }))

test("the loopback server exposes only the three reviewed dashboard assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-dashboard-test-"))
  const dashboardDirectory = join(root, "dashboard")
  await mkdir(dashboardDirectory)
  await Promise.all([
    writeFile(
      join(dashboardDirectory, "index.html"),
      "<!doctype html><title>Control plane</title>",
    ),
    writeFile(join(dashboardDirectory, "app.js"), "console.log('dashboard')"),
    writeFile(join(dashboardDirectory, "app.css"), "body{background:#07111f}"),
  ])
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite")),
  )
  const server = await Effect.runPromise(
    startControlPlaneServer({
      host: "127.0.0.1",
      port: 0,
      store,
      dashboardDirectory,
    }),
  )
  try {
    const index = await fetch(`${server.origin}/`)
    assert.equal(index.status, 200)
    assert.match(index.headers.get("content-type") ?? "", /text\/html/)
    assert.match(
      index.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    )
    assert.match(await index.text(), /Control plane/)

    assert.match(
      (await fetch(`${server.origin}/app.js`)).headers.get("content-type") ??
        "",
      /javascript/,
    )
    assert.match(
      (await fetch(`${server.origin}/app.css`)).headers.get("content-type") ??
        "",
      /text\/css/,
    )
    assert.equal((await fetch(`${server.origin}/not-an-asset`)).status, 404)
    assert.equal(
      (await fetch(`${server.origin}/app.js`, { method: "POST" })).status,
      405,
    )
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
