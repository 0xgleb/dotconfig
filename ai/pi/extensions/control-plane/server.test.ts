import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
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
