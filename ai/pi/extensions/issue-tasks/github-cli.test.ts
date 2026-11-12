import assert from "node:assert/strict"
import { execFile, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Cause, Deferred, Effect, Either, Exit } from "effect"
import { createGitHubCliReader, type GitHubCliLaunch } from "./github-cli.ts"
import {
  GITHUB_ISSUE_GET_DOCUMENT,
  GITHUB_ISSUE_LIST_DOCUMENT,
  MAX_GITHUB_READ_BYTES,
} from "./github-read.ts"

const cwd = fileURLToPath(new URL("../../../../", import.meta.url))
const program = fileURLToPath(
  new URL("./test-fixtures/github-cli.mjs", import.meta.url),
)
const fixtureParent = fileURLToPath(
  new URL("../../../../.tmp/issue-github-cli-tests/", import.meta.url),
)
const query = {
  repository: "0xGleb/DotConfig",
  state: "open",
  page: { limit: 1 },
}
const getQuery = {
  issue: { repository: "0xGleb/DotConfig", number: 86 },
  related: {
    limit: 1,
    blockedByAfter: "dep-before",
    deliveryAfter: "pr-before",
  },
}
const probe = (mode: string, timeout?: number) => {
  const events: string[] = []
  const stderrSizes: number[] = []
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
      [program, mode],
      { ...options, ...(timeout === undefined ? {} : { timeout }) },
      (error, stdout, stderr) => {
        events.push("callback")
        stderrSizes.push(stderr.length)
        callback(error, stdout, stderr)
      },
    )
    children.push(child)
    child.stdout?.once("data", () =>
      Effect.runSync(Deferred.succeed(entered, undefined)),
    )
    child.once("exit", () => events.push("exit"))
    closures.push(
      new Promise(resolve =>
        child.once("close", () => {
          events.push("close")
          closed.add(child)
          resolve()
        }),
      ),
    )
    return child
  }
  const cleanup = async () => {
    for (const child of children)
      if (
        !closed.has(child) &&
        child.exitCode === null &&
        child.signalCode === null
      )
        child.kill("SIGKILL")
    await Promise.all(closures)
  }
  return { launch, events, stderrSizes, children, closed, entered, cleanup }
}
const expectFailure = async <E extends { readonly code: string }>(
  operation: Effect.Effect<unknown, E>,
  code: E["code"],
) => {
  const result = await Effect.runPromise(Effect.either(operation))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, code)
  assert.ok(!JSON.stringify(result.left).includes("Private"))
  return result.left
}

test("native GitHub CLI reader uses fixed arguments and actual JSON stdin for list/get", async t => {
  const child = probe("success")
  t.after(child.cleanup)
  const reader = createGitHubCliReader({ cwd, launch: child.launch })
  const list = await Effect.runPromise(reader.list(query))
  assert.deepEqual(JSON.parse(list.issues[0]?.title ?? "null"), {
    query: GITHUB_ISSUE_LIST_DOCUMENT,
    variables: {
      owner: "0xgleb",
      name: "dotconfig",
      first: 1,
      after: null,
      states: ["OPEN"],
    },
  })
  const get = await Effect.runPromise(reader.get(getQuery))
  assert.deepEqual(JSON.parse(get.detail?.body ?? "null"), {
    query: GITHUB_ISSUE_GET_DOCUMENT,
    variables: {
      owner: "0xgleb",
      name: "dotconfig",
      number: 86,
      relatedFirst: 1,
      blockedByAfter: "dep-before",
      deliveryAfter: "pr-before",
    },
  })
  assert.equal(child.children.length, 2)
  assert.equal(child.closed.size, 2)
})

test("native GitHub CLI captures host execution configuration before later caller mutation", async t => {
  const child = probe("success")
  t.after(child.cleanup)
  const options = { cwd, launch: child.launch }
  const reader = createGitHubCliReader(options)
  options.cwd = "."
  options.launch = () =>
    assert.fail(
      "Later launch mutation must not replace the captured host capability",
    )
  const result = await Effect.runPromise(reader.list(query))
  assert.equal(result.issues.length, 1)
  assert.equal(child.closed.size, 1)
})

test("native GitHub CLI does not launch for malformed requests or pre-aborted reads", async t => {
  const child = probe("success")
  t.after(child.cleanup)
  const reader = createGitHubCliReader({ cwd, launch: child.launch })
  await expectFailure(
    reader.list({ ...query, page: { limit: 0 } }),
    "invalid_request",
  )
  await expectFailure(
    reader.get({
      ...getQuery,
      issue: { ...getQuery.issue, number: 2_147_483_648 },
    }),
    "invalid_request",
  )
  const controller = new AbortController()
  controller.abort()
  const result = await Effect.runPromiseExit(reader.list(query), {
    signal: controller.signal,
  })
  assert.ok(Exit.isFailure(result) && Cause.isInterruptedOnly(result.cause))
  assert.equal(child.children.length, 0)
})

test("native GitHub CLI admits the exact byte limit before decoding its complete response", async t => {
  const child = probe("exact")
  t.after(child.cleanup)
  const result = await Effect.runPromise(
    createGitHubCliReader({ cwd, launch: child.launch }).list(query),
  )
  assert.equal(result.issues.length, 1)
  assert.equal(child.closed.size, 1)
})

test("native GitHub CLI admits exact stderr capacity alongside a complete successful reply", async t => {
  const child = probe("stderr-exact")
  t.after(child.cleanup)
  const result = await Effect.runPromise(
    createGitHubCliReader({ cwd, launch: child.launch }).list(query),
  )
  assert.equal(result.issues.length, 1)
  assert.deepEqual(child.stderrSizes, [MAX_GITHUB_READ_BYTES])
  assert.equal(child.closed.size, 1)
})

for (const mode of ["oversize", "unicode-over", "stderr-over"] as const) {
  test(`native GitHub CLI rejects ${mode} without decoding clipped output`, async t => {
    const child = probe(mode)
    t.after(child.cleanup)
    await expectFailure(
      createGitHubCliReader({ cwd, launch: child.launch }).list(query),
      "transport_error",
    )
    assert.equal(child.children.length, 1)
    assert.equal(child.closed.size, 1)
    if (mode === "stderr-over")
      assert.equal(child.children[0]?.signalCode, "SIGKILL")
  })
}

test("native GitHub CLI rejects malformed UTF8 without replacement and preserves JSON decode failures", async t => {
  for (const [mode, expected] of [
    ["invalid-utf8", "transport_error"],
    ["bad-json", "invalid_response"],
  ] as const) {
    const child = probe(mode)
    t.after(child.cleanup)
    await expectFailure(
      createGitHubCliReader({ cwd, launch: child.launch }).list(query),
      expected,
    )
    assert.equal(child.closed.size, 1)
  }
})

test("native GitHub CLI sanitizes nonzero diagnostics and waits for close before failure", async t => {
  const child = probe("nonzero")
  t.after(child.cleanup)
  await expectFailure(
    createGitHubCliReader({ cwd, launch: child.launch }).list(query),
    "transport_error",
  )
  child.events.push("settled")
  assert.equal(child.closed.size, 1)
  assert.ok(child.events.indexOf("close") < child.events.indexOf("settled"))
})

test("native GitHub CLI spawn failure is typed and close-observed", async () => {
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(fixtureParent, "spawn-"))
  try {
    let closed = false
    const launch: GitHubCliLaunch = (_args, options, callback) => {
      const child = execFile(
        join(root, "missing-executable"),
        [],
        options,
        callback,
      )
      child.once("close", () => {
        closed = true
      })
      return child
    }
    await expectFailure(
      createGitHubCliReader({ cwd, launch }).list(query),
      "transport_error",
    )
    assert.equal(closed, true)
  } finally {
    rmSync(root, { recursive: true })
  }
})

test("native GitHub CLI rejects relative host cwd instead of guessing an execution location", async t => {
  const child = probe("success")
  t.after(child.cleanup)
  await expectFailure(
    createGitHubCliReader({ cwd: ".", launch: child.launch }).list(query),
    "transport_error",
  )
  assert.equal(child.children.length, 0)
})

test(
  "native GitHub CLI stdin failure kills and closes its actual process",
  { timeout: 5_000 },
  async t => {
    const child = probe("hang")
    t.after(child.cleanup)
    const launch: GitHubCliLaunch = (args, options, callback) => {
      const process = child.launch(args, options, callback)
      process.stdin?.destroy(new Error("Private fixture stdin failure"))
      return process
    }
    await expectFailure(
      createGitHubCliReader({ cwd, launch }).list(query),
      "transport_error",
    )
    assert.equal(child.closed.size, 1)
  },
)

test(
  "native GitHub CLI abort waits for actual close before the Effect exits",
  { timeout: 5_000 },
  async t => {
    const child = probe("hang")
    t.after(child.cleanup)
    const controller = new AbortController()
    t.signal.addEventListener("abort", () => controller.abort(), { once: true })
    const pending = Effect.runPromiseExit(
      createGitHubCliReader({ cwd, launch: child.launch }).list(query),
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

test(
  "native GitHub CLI timeout rejects after close, not after merely sending a signal",
  { timeout: 5_000 },
  async t => {
    const child = probe("hang", 50)
    t.after(child.cleanup)
    await expectFailure(
      createGitHubCliReader({ cwd, launch: child.launch }).list(query),
      "transport_error",
    )
    assert.equal(child.closed.size, 1)
  },
)
