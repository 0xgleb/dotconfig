import assert from "node:assert/strict"
import { execFile, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Cause, Deferred, Effect, Either, Exit } from "effect"
import {
  createGitHubCliProjectReader,
  createGitHubCliPickupClient,
  type GitHubCliLaunch,
} from "./github-cli.ts"
import { MAX_GITHUB_READ_BYTES } from "./github-read.ts"
import { GITHUB_PROJECT_SCHEDULING_DOCUMENT } from "./github-project-read.ts"

const cwd = fileURLToPath(new URL("../../../../", import.meta.url))
const program = fileURLToPath(
  new URL("./test-fixtures/github-project-cli.mjs", import.meta.url),
)
const probe = (mode = "success", fixtureProgram = program) => {
  const children: ChildProcess[] = []
  const closed = new Set<ChildProcess>()
  const closures: Promise<void>[] = []
  const entered = Effect.runSync(Deferred.make<void>())
  const launch: GitHubCliLaunch = (args, options, callback) => {
    assert.deepEqual(args, [
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "--input",
      "-",
    ])
    assert.equal(options.cwd, cwd)
    assert.equal(options.encoding, "buffer")
    assert.equal(options.shell, false)
    assert.equal(options.maxBuffer, MAX_GITHUB_READ_BYTES)
    assert.equal(options.timeout, 30_000)
    assert.equal(options.killSignal, "SIGKILL")

    const child = execFile(
      process.execPath,
      [fixtureProgram, mode],
      options,
      callback,
    )
    children.push(child)
    child.stdout?.once("data", () =>
      Effect.runSync(Deferred.succeed(entered, undefined)),
    )
    closures.push(
      new Promise(resolve =>
        child.once("close", () => {
          closed.add(child)
          resolve()
        }),
      ),
    )
    return child
  }
  const cleanup = async () => {
    for (const child of children) {
      if (
        !closed.has(child) &&
        child.exitCode === null &&
        child.signalCode === null
      )
        child.kill("SIGKILL")
    }
    await Promise.all(closures)
  }
  return { launch, children, closed, entered, cleanup }
}

test("native pickup uses the same bounded subprocess transport for read and narrow mutations", async t => {
  const source = probe()
  const pickup = probe(
    "success",
    fileURLToPath(
      new URL("./test-fixtures/github-pickup-cli.mjs", import.meta.url),
    ),
  )
  t.after(source.cleanup)
  t.after(pickup.cleanup)
  const page = await Effect.runPromise(
    createGitHubCliProjectReader({ cwd, launch: source.launch }).read({
      project: "personal",
      page: { limit: 1 },
    }),
  )
  const item = page.items[0]
  assert.ok(item?.kind === "issue")
  const target = {
    issue: item.issue,
    issueNodeId: item.issueNodeId,
    itemId: item.itemId,
    viewer: page.viewer,
    inProgress: page.inProgress,
  }
  const client = createGitHubCliPickupClient({ cwd, launch: pickup.launch })
  const observed = await Effect.runPromise(client.inspect(target))
  assert.equal(observed.itemId, target.itemId)
  assert.deepEqual(observed.assignees, [page.viewer])
  let dispatches = 0
  const invocation = { sessionId: "native-session", toolCallId: "native-call" }
  await Effect.runPromise(
    client.assignOwner(target, invocation, () => {
      dispatches++
    }),
  )
  await Effect.runPromise(
    client.setInProgress(target, invocation, () => {
      dispatches++
    }),
  )
  assert.equal(dispatches, 2)
  assert.equal(pickup.children.length, 3)
  assert.equal(pickup.closed.size, 3)
})

test("native Project reader uses existing bounded transport and actual fixed-query JSON stdin", async t => {
  const child = probe()
  t.after(child.cleanup)
  const reader = createGitHubCliProjectReader({ cwd, launch: child.launch })

  for (const [project, id] of [
    ["personal", "PVT_kwHOAl_tIc4BpO1U"],
    ["dataclique", "PVT_kwDOCA_DB84BkDqI"],
  ] as const) {
    const page = await Effect.runPromise(
      reader.read({ project, page: { limit: 2, after: "opaque" } }),
    )
    const item = page.items[0]

    assert.equal(page.project, project)
    assert.deepEqual(page.viewer, { id: "fixture-viewer-id", login: "0xgleb" })
    assert.equal(page.inProgress.projectId, id)
    assert.equal(page.inProgress.optionId, "47fc9ee4")
    assert.ok(item?.kind === "issue")
    assert.equal(item.issueNodeId, "fixture-issue-node-id")
    assert.deepEqual(item.assignees, [])
    assert.deepEqual(item.issue, { repository: "owner/repository", number: 7 })
    assert.deepEqual(item.priority, { kind: "number", value: 2 })
    assert.deepEqual(item.effort, { kind: "number", value: 5 })
    assert.deepEqual(JSON.parse(item.itemId), {
      query: GITHUB_PROJECT_SCHEDULING_DOCUMENT,
      variables: { project: id, first: 2, after: "opaque" },
    })
  }
  assert.equal(child.children.length, 2)
  assert.equal(child.closed.size, 2)
})

test("native Project reader captures host settings and rejects invalid/pre-aborted reads before launch", async t => {
  const child = probe()
  t.after(child.cleanup)
  const options = { cwd, launch: child.launch }
  const reader = createGitHubCliProjectReader(options)
  options.cwd = "."
  options.launch = () => assert.fail("host callback was not captured")
  const invalid = await Effect.runPromise(
    Effect.either(reader.read({ project: "other", page: { limit: 1 } })),
  )

  assert.ok(Either.isLeft(invalid))
  assert.equal(invalid.left.code, "invalid_request")
  const controller = new AbortController()
  controller.abort()
  const aborted = await Effect.runPromiseExit(
    reader.read({ project: "personal", page: { limit: 1 } }),
    { signal: controller.signal },
  )

  assert.ok(Exit.isFailure(aborted) && Cause.isInterruptedOnly(aborted.cause))
  assert.equal(child.children.length, 0)
  const page = await Effect.runPromise(
    reader.read({ project: "personal", page: { limit: 1 } }),
  )

  assert.equal(page.items.length, 1)
  assert.equal(child.closed.size, 1)
})

test(
  "native Project reader interruption waits for process close",
  { timeout: 5_000 },
  async t => {
    const child = probe("hang")
    t.after(child.cleanup)
    const controller = new AbortController()
    t.signal.addEventListener("abort", () => controller.abort(), { once: true })
    const pending = Effect.runPromiseExit(
      createGitHubCliProjectReader({ cwd, launch: child.launch }).read({
        project: "personal",
        page: { limit: 1 },
      }),
      { signal: controller.signal },
    )
    try {
      assert.equal(
        await Promise.race([
          Effect.runPromise(Deferred.await(child.entered)).then(() => true),
          pending.then(() => false),
        ]),
        true,
      )
      controller.abort()
      const result = await pending

      assert.ok(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause))
      assert.equal(child.closed.size, 1)
    } finally {
      controller.abort()
      await pending
    }
  },
)
