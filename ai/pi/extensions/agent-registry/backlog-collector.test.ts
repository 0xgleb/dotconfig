import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Option } from "effect"

import {
  collectDeclaredBacklogSources,
  collectDeclaredGitHubBacklog,
  makeDeclaredBacklogCommandRunner,
  makeDeclaredBacklogFileReader,
  safeBacklogCommandEnvironment,
  stopChild,
  type DeclaredBacklogCommandRunner,
  type DeclaredBacklogFileReader,
} from "./backlog-collector.ts"

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect)

const reader =
  (
    files: Readonly<Record<string, string>>,
    reads: string[],
  ): DeclaredBacklogFileReader =>
  (relativePath, _maxBytes) => {
    reads.push(relativePath)
    return Effect.succeed(
      Object.hasOwn(files, relativePath)
        ? Option.some(files[relativePath] ?? "")
        : Option.none(),
    )
  }

test("declared backlog collector is model-free, trust-gated, and absence-safe", async () => {
  const reads: string[] = []
  const untrusted = await run(
    collectDeclaredBacklogSources({
      project: "/repo",
      configDirName: ".pi",
      trusted: false,
      observedAt: 1,
      readFile: reader({}, reads),
    }),
  )
  assert.deepEqual(untrusted, { snapshots: [] })
  assert.deepEqual(reads, [])

  const absent = await run(
    collectDeclaredBacklogSources({
      project: "/repo",
      configDirName: ".pi",
      trusted: true,
      observedAt: 2,
      readFile: reader({}, reads),
    }),
  )
  assert.deepEqual(absent, { snapshots: [] })
  assert.deepEqual(reads, [".pi/backlog-sources.json"])
})

test("declared backlog collector reads only the exact manifest document", async () => {
  const reads: string[] = []
  const collected = await run(
    collectDeclaredBacklogSources({
      project: "/repo",
      configDirName: ".pi",
      trusted: true,
      observedAt: 3,
      readFile: reader(
        {
          ".pi/backlog-sources.json": JSON.stringify({
            version: 1,
            document: "BACKLOG.md",
          }),
          "BACKLOG.md": [
            "<!-- pi-backlog:complete -->",
            "```pi-backlog",
            JSON.stringify({
              id: "declared-one",
              status: "ready",
              priority: "normal",
              requirements: ["Preserve this declared requirement"],
            }),
            "```",
          ].join("\n"),
        },
        reads,
      ),
    }),
  )

  assert.deepEqual(reads, [".pi/backlog-sources.json", "BACKLOG.md"])
  assert.equal(collected.snapshots.length, 1)
  assert.equal(collected.snapshots[0]?.source, "backlog-document")
  assert.equal(collected.snapshots[0]?.coverage, "complete")
  assert.deepEqual(collected.snapshots[0]?.items[0]?.requirements, [
    "Preserve this declared requirement",
  ])
})

test("declared backlog collector preserves a GitHub declaration when no collector is installed", async () => {
  const collected = await run(
    collectDeclaredBacklogSources({
      project: "/repo",
      configDirName: ".pi",
      trusted: true,
      observedAt: 4,
      readFile: reader(
        {
          ".pi/backlog-sources.json": JSON.stringify({
            version: 1,
            github: { repository: "example/repo" },
          }),
        },
        [],
      ),
    }),
  )

  assert.deepEqual(collected, {
    snapshots: [],
    github: { repository: "example/repo" },
  })
})

test("declared backlog collector invokes the installed GitHub collector exactly once", async () => {
  const declarations: unknown[] = []
  const collected = await run(
    collectDeclaredBacklogSources({
      project: "/repo",
      configDirName: ".pi",
      trusted: true,
      observedAt: 5,
      readFile: reader(
        {
          ".pi/backlog-sources.json": JSON.stringify({
            version: 1,
            github: {},
          }),
        },
        [],
      ),
      collectGitHub: declared => {
        declarations.push(declared)
        return Effect.succeed({
          project: "/repo",
          source: "tracker-item",
          scopeId: "github:example/repo",
          coverage: "complete",
          observedAt: 5,
          items: [],
        })
      },
    }),
  )

  assert.deepEqual(declarations, [{}])
  assert.equal(collected.github, undefined)
  assert.deepEqual(
    collected.snapshots.map(snapshot => snapshot.source),
    ["tracker-item"],
  )
})

test("declared backlog file reader reads only bounded regular fixture files and honors cancellation", async () => {
  const project = fileURLToPath(
    new URL("./testdata/backlog-project/", import.meta.url),
  )
  const collected = await run(
    collectDeclaredBacklogSources({
      project,
      configDirName: ".pi",
      trusted: true,
      observedAt: 6,
      readFile: makeDeclaredBacklogFileReader(project),
    }),
  )
  assert.deepEqual(collected.snapshots[0]?.items[0]?.requirements, [
    "Fixture requirement",
  ])

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    run(
      makeDeclaredBacklogFileReader(project, controller.signal)(
        "BACKLOG.md",
        4_096,
      ),
    ),
    /cancelled/,
  )
})

test("declared backlog collector rejects traversal, protected, unknown, and empty manifests", async () => {
  for (const manifest of [
    { version: 1, document: "../BACKLOG.md" },
    { version: 1, document: "secrets.age" },
    { version: 1, document: "BACKLOG.md", extra: true },
    { version: 1 },
  ]) {
    await assert.rejects(
      run(
        collectDeclaredBacklogSources({
          project: "/repo",
          configDirName: ".pi",
          trusted: true,
          observedAt: 5,
          readFile: reader(
            { ".pi/backlog-sources.json": JSON.stringify(manifest) },
            [],
          ),
        }),
      ),
      /manifest|document/i,
    )
  }
})

const githubRunner =
  (
    origin: string,
    issuePages: readonly unknown[],
    pullPages: readonly unknown[],
    calls: string[],
  ): DeclaredBacklogCommandRunner =>
  request => {
    calls.push(`${request.kind}:${request.page ?? 0}`)
    if (request.kind === "git-origin") {
      assert.deepEqual(request.args, [
        "config",
        "--local",
        "--get",
        "remote.origin.url",
      ])
      return Effect.succeed(origin)
    }
    assert.match(
      request.args.at(-1) ?? "",
      /[?&]sort=created&direction=asc(?:&|$)/,
    )
    const hostnameFlag = request.args.indexOf("--hostname")
    assert.notEqual(hostnameFlag, -1)
    assert.equal(request.args[hostnameFlag + 1], "github.com")
    const pages = request.kind === "github-issues" ? issuePages : pullPages
    return Effect.succeed(JSON.stringify(pages[(request.page ?? 1) - 1] ?? []))
  }

test("declared GitHub collector resolves the exact origin and fully paginates issues and pull requests", async () => {
  const calls: string[] = []
  const firstIssuePage: unknown[] = Array.from({ length: 99 }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    body: index === 0 ? "Preserve every issue requirement" : null,
    state: "open",
    state_reason: null,
    updated_at: "2026-09-01T00:00:00Z",
    labels: index === 0 ? [{ name: "priority:urgent" }] : [],
  }))
  firstIssuePage.push({
    number: 9_999,
    title: "PR duplicate from issues endpoint",
    body: null,
    state: "open",
    state_reason: null,
    updated_at: "2026-09-01T00:00:00Z",
    labels: [],
    pull_request: {
      url: "https://api.github.com/repos/example/repo/pulls/9999",
    },
  })
  const snapshot = await run(
    collectDeclaredGitHubBacklog({
      project: "/repo",
      declared: { repository: "example/repo" },
      observedAt: 7,
      runCommand: githubRunner(
        "git@github.com:example/repo.git\n",
        [
          firstIssuePage,
          [
            {
              number: 101,
              title: "Issue 101",
              body: null,
              state: "closed",
              state_reason: "not_planned",
              updated_at: "2026-09-02T00:00:00Z",
              labels: [],
            },
          ],
        ],
        [
          [
            {
              number: 201,
              title: "Merged repair",
              body: "Keep the merge requirement",
              state: "closed",
              merged_at: "2026-09-03T00:00:00Z",
              updated_at: "2026-09-03T00:00:00Z",
              labels: [{ name: "blocked" }],
            },
          ],
        ],
        calls,
      ),
    }),
  )

  assert.equal(snapshot.scopeId, "github:example/repo")
  assert.equal(snapshot.coverage, "complete")
  assert.equal(snapshot.items.length, 101)
  assert.equal(snapshot.items[0]?.priority, "urgent")
  assert.equal(snapshot.items[99]?.status, "cancelled")
  assert.equal(snapshot.items[100]?.status, "completed")
  assert.deepEqual(calls, [
    "git-origin:0",
    "github-issues:1",
    "github-issues:2",
    "github-pulls:1",
  ])
})

test("declared GitHub collector rejects origin mismatch before API access and fails closed on malformed pages", async () => {
  const mismatchCalls: string[] = []
  await assert.rejects(
    run(
      collectDeclaredGitHubBacklog({
        project: "/repo",
        declared: { repository: "other/repo" },
        observedAt: 8,
        runCommand: githubRunner(
          "https://github.com/example/repo.git\n",
          [],
          [],
          mismatchCalls,
        ),
      }),
    ),
    /origin|repository/i,
  )
  assert.deepEqual(mismatchCalls, ["git-origin:0"])

  await assert.rejects(
    run(
      collectDeclaredGitHubBacklog({
        project: "/repo",
        declared: {},
        observedAt: 9,
        runCommand: githubRunner(
          "ssh://git@github.com/example/repo.git\n",
          [[{ number: 1, title: "Missing required fields" }]],
          [],
          [],
        ),
      }),
    ),
    /GitHub|tracker|malformed|page/i,
  )

  await assert.rejects(
    run(
      collectDeclaredGitHubBacklog({
        project: "/repo",
        declared: {},
        observedAt: 10,
        runCommand: githubRunner(
          "git@github.com:example/repo.git\n",
          [
            [
              {
                number: 1,
                title: "Impossible issue state",
                body: null,
                state: "open",
                state_reason: "completed",
                updated_at: "2026-09-01T00:00:00Z",
                labels: [],
              },
            ],
          ],
          [],
          [],
        ),
      }),
    ),
    /GitHub tracker page|malformed/i,
  )

  await assert.rejects(
    run(
      collectDeclaredGitHubBacklog({
        project: "/repo",
        declared: {},
        observedAt: 11,
        runCommand: githubRunner(
          "git@github.com:example/repo.git\n",
          [
            [
              {
                number: 1,
                title: "Credential disclosure",
                body: `Leaked token ghp_${"a".repeat(24)}`,
                state: "open",
                state_reason: null,
                updated_at: "2026-09-01T00:00:00Z",
                labels: [],
              },
            ],
          ],
          [],
          [],
        ),
      }),
    ),
    /credential|secret|GitHub tracker page/i,
  )
})

test("collector child termination escalates after a bounded grace period", async () => {
  const signals: NodeJS.Signals[] = []
  const child = {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: (signal: NodeJS.Signals) => {
      signals.push(signal)
      return true
    },
    once: () => child,
  }
  await run(
    stopChild(
      child as unknown as ReturnType<typeof import("node:child_process").spawn>,
      10,
    ),
  )
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("GitHub subprocess runner resolves the repository origin without forwarding credential variables", async () => {
  assert.deepEqual(
    safeBacklogCommandEnvironment({
      HOME: "/Users/example",
      PATH: "/repo/bin:/bin:/usr/bin:/nix/store/abc-git/bin",
      XDG_CONFIG_HOME: "/repo/.config",
      GH_TOKEN: "never-forward",
      GITHUB_TOKEN: "never-forward",
      CUSTOM_SECRET: "never-forward",
    }),
    {
      HOME: "/Users/example",
      PATH: "/bin:/usr/bin:/nix/store/abc-git/bin",
    },
  )

  const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url))
  const origin = await run(
    makeDeclaredBacklogCommandRunner()({
      kind: "git-origin",
      command: "git",
      args: ["config", "--local", "--get", "remote.origin.url"],
      cwd: repositoryRoot,
      maxOutputBytes: 1_024,
      timeoutMs: 1_000,
    }),
  )
  assert.match(origin, /github\.com[/:]0xgleb\/dotconfig(?:\.git)?/)

  await assert.rejects(
    run(
      makeDeclaredBacklogCommandRunner(
        undefined,
        0,
      )({
        kind: "git-origin",
        command: "git",
        args: ["config", "--local", "--get", "remote.origin.url"],
        cwd: "/repo",
        maxOutputBytes: 1_024,
        timeoutMs: 1_000,
      }),
    ),
    /timed out/,
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    run(
      makeDeclaredBacklogCommandRunner(controller.signal)({
        kind: "git-origin",
        command: "git",
        args: ["config", "--local", "--get", "remote.origin.url"],
        cwd: "/repo",
        maxOutputBytes: 1_024,
        timeoutMs: 1_000,
      }),
    ),
    /cancelled/,
  )
})
