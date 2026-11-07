import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import { toJobId, type JobId, type Job } from "./job-runtime.ts"
import { startControlPlaneServer, type ControlPlaneJobStore } from "./server.ts"
import {
  makeSqliteJobStore,
  type SqliteJobStore,
  type StoredJob,
} from "./sqlite-job-store.ts"

const jobIdentifier = (value: string): JobId => {
  const id = toJobId(value)
  if (id === undefined)
    throw new Error(`fixture is not a job identifier: ${value}`)
  return id
}

/**
 * A store that implements only the operations a test exercises. Every other
 * operation dies rather than being faked, so a route that starts touching one
 * fails the test that did not expect it instead of reading a stub's answer.
 */
const partialStore = (
  operations: Partial<ControlPlaneJobStore>,
): ControlPlaneJobStore => ({
  enqueue: unavailable("enqueue"),
  get: unavailable("get"),
  list: unavailable("list"),
  claimDue: unavailable("claimDue"),
  complete: unavailable("complete"),
  fail: unavailable("fail"),
  recoverExpired: unavailable("recoverExpired"),
  recordUsage: unavailable("recordUsage"),
  recordAllowanceCheckpoint: unavailable("recordAllowanceCheckpoint"),
  ...operations,
})

const unavailable = (operation: string) => (): Effect.Effect<never> =>
  Effect.die(new Error(`the test store does not implement ${operation}`))

const readableJobs = (stored: readonly StoredJob[]): readonly Job[] =>
  stored.flatMap(entry => (entry.outcome === "readable" ? [entry.job] : []))

const withServer = async (
  run: (origin: string, store: SqliteJobStore) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "pi-control-plane-http-test-"))
  const store = await Effect.runPromise(
    makeSqliteJobStore(join(root, "jobs.sqlite")),
  )
  const server = await Effect.runPromise(
    startControlPlaneServer({ host: "127.0.0.1", port: 0, store }),
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
  kind: "harness.research",
  payload: {
    lane: "subscription-plan",
    harness: "claude-plan",
    profile: "research-config",
    project: "dotconfig",
    task: "subscription-harness-adversarial-review",
    repositoryRoot: "/Users/example/.config",
    isolation: "read-only",
    ownership: {
      kind: "project-domain",
      project: "dotconfig",
      role: "research-config",
    },
  },
  runAt: 1_000,
  maxAttempts: 3,
  recurrence: {
    baseMs: 2 * 60 * 60 * 1_000,
    jitterMs: 60 * 60 * 1_000,
  },
  idempotencyKey: "research:dotconfig:1",
}

const retryEnqueueBody = {
  ...enqueueBody,
  maxAttempts: 2,
  idempotencyKey: "research:retry",
}

const researchHandoff = (jobId: string, attempt: number) => ({
  protocolVersion: 1,
  jobId,
  attempt,
  lane: "subscription-plan",
  profile: enqueueBody.payload.profile,
  task: enqueueBody.payload.task,
  status: "completed",
  summary: "Verified the bounded research task",
  evidence: ["source.ts: task boundary verified"],
})

test("the server refuses non-loopback bind addresses", async () => {
  const result = await Effect.runPromise(
    Effect.either(
      startControlPlaneServer({
        host: "0.0.0.0",
        port: 0,
        store: partialStore({}),
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
    assert.deepEqual(await jobs.json(), { jobs: [], unreadable: [] })
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

test("research enqueue requires project ownership and valid scheduling", async () =>
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
    const payload = {
      lane: "subscription-plan",
      harness: "claude-plan",
      profile: "yielduck-research",
      project: "yielduck",
      task: "yielduck-portfolio-replay-attribution",
      repositoryRoot: "/Users/example/yielduck",
      isolation: "read-only",
      ownership: {
        kind: "project-domain",
        project: "yielduck",
        role: "yielduck-research",
      },
    }
    const { ownership, ...unowned } = payload
    assert.equal((await post(unowned)).status, 400)
    assert.equal(
      (
        await post({
          ...payload,
          ownership: { ...ownership, project: "another-project" },
        })
      ).status,
      400,
    )
    assert.equal((await post(payload, 8)).status, 400)
    assert.equal((await post(payload)).status, 201)
  }))

test("concurrent idempotent enqueue reports exactly one creation", async () => {
  const job: Job = {
    id: jobIdentifier("job-a"),
    spec: {
      ...enqueueBody,
      kind: "harness.research",
      payload: {
        ...enqueueBody.payload,
        lane: "subscription-plan",
        isolation: "read-only",
        ownership: { ...enqueueBody.payload.ownership, kind: "project-domain" },
      },
    },
    state: "ready",
    attempt: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
  let enqueueCount = 0
  let listCount = 0
  let releaseLists: (() => void) | undefined
  const listsReleased = new Promise<void>(resolve => {
    releaseLists = resolve
  })
  const store = partialStore({
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
  })
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
      body: JSON.stringify({
        leaseToken: "stale-token",
        handoff: researchHandoff(created.job.id, 1),
      }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      error: { code: "stale_lease", message: "job lease is stale" },
    })

    for (const handoff of [
      { ...researchHandoff(created.job.id, 1), jobId: "another-job" },
      researchHandoff(created.job.id, 2),
      { ...researchHandoff(created.job.id, 1), status: "failed" },
    ]) {
      const rejected = await fetch(
        `${origin}/v1/jobs/${created.job.id}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leaseToken: claimed.job.leaseToken, handoff }),
        },
      )
      assert.equal(rejected.status, 400)
    }

    const complete = await fetch(
      `${origin}/v1/jobs/${created.job.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leaseToken: claimed.job.leaseToken,
          handoff: researchHandoff(created.job.id, 1),
        }),
      },
    )
    assert.equal(complete.status, 200)
    assert.equal(
      ((await complete.json()) as { job: { state: string } }).job.state,
      "succeeded",
    )
  }))

test("completing a job that does not exist reports it as missing", async () =>
  withServer(async origin => {
    const missing = await fetch(`${origin}/v1/jobs/absent-job/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseToken: "lease-a", summary: "done" }),
    })
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), {
      error: { code: "not_found", message: "job was not found" },
    })
  }))

test("kind-filtered worker claims accept only registered bounded kinds", async () =>
  withServer(async origin => {
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...enqueueBody, runAt: 0 }),
    })
    assert.equal(enqueued.status, 201)

    for (const kinds of [
      [],
      ["unregistered.kind"],
      [42],
      ["harness.research", "harness.research"],
      Array.from({ length: 9 }, () => "harness.research"),
      "harness.research",
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
        kinds: ["harness.research"],
      }),
    })
    assert.equal(matching.status, 200)
    const claimed = (await matching.json()) as {
      job: { spec: { kind: string } }
    }
    assert.equal(claimed.job.spec.kind, "harness.research")
  }))

test("failed attempts retry through the fail route until attempts are exhausted", async () =>
  withServer(async origin => {
    const enqueued = await fetch(`${origin}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(retryEnqueueBody),
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
      body: JSON.stringify(retryEnqueueBody),
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
    assert.deepEqual(await rejected.json(), {
      error: { code: "invalid_input", message: "request payload is invalid" },
    })
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
    assert.deepEqual(readableJobs(await Effect.runPromise(store.list())), [])
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
