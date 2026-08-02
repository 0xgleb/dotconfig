import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"
import { startControlPlaneServer } from "./server.ts"
import { makeSqliteJobStore, type SqliteJobStore } from "./sqlite-job-store.ts"

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
  withServer(async (origin) => {
    const health = await fetch(`${origin}/v1/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      status: "ok",
      protocolVersion: 1,
      schemaVersion: 1,
    })

    const jobs = await fetch(`${origin}/v1/jobs`)
    assert.equal(jobs.status, 200)
    assert.deepEqual(await jobs.json(), { jobs: [] })
  }))

test("registered enqueue is idempotent and unknown executable kinds fail closed", async () =>
  withServer(async (origin) => {
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
  const listsReleased = new Promise<void>((resolve) => {
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
    assert.deepEqual(
      responses.map(({ status }) => status).sort(),
      [200, 201],
    )
    const jobs = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ job: { id: string } }>,
      ),
    )
    assert.equal(jobs[0]?.job.id, jobs[1]?.job.id)
    assert.equal(listCount, 0, "enqueue status must not depend on a list snapshot")
  } finally {
    await Effect.runPromise(server.close)
  }
})

test("workers claim due jobs with server-issued leases and stale completion is fenced", async () =>
  withServer(async (origin) => {
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

    const complete = await fetch(`${origin}/v1/jobs/${created.job.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: claimed.job.leaseToken,
        summary: "review scan completed",
      }),
    })
    assert.equal(complete.status, 200)
    assert.equal(((await complete.json()) as { job: { state: string } }).job.state, "succeeded")
  }))

test("worker boundaries reject unknown fields and client-supplied lease tokens", async () =>
  withServer(async (origin) => {
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
  withServer(async (origin) => {
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
    writeFile(join(dashboardDirectory, "index.html"), "<!doctype html><title>Control plane</title>"),
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
    assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/)
    assert.match(await index.text(), /Control plane/)

    assert.match(
      (await fetch(`${server.origin}/app.js`)).headers.get("content-type") ?? "",
      /javascript/,
    )
    assert.match(
      (await fetch(`${server.origin}/app.css`)).headers.get("content-type") ?? "",
      /text\/css/,
    )
    assert.equal((await fetch(`${server.origin}/not-an-asset`)).status, 404)
    assert.equal((await fetch(`${server.origin}/app.js`, { method: "POST" })).status, 405)
  } finally {
    await Effect.runPromise(server.close)
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
