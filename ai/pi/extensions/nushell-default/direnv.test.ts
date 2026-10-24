import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"

import {
  applyDirenvEnvironment,
  commandManagesOwnEnvironment,
  createDirenvEnvironmentLoader,
  decodeDirenvExport,
  findNearestEnvrcDirectory,
  findNearestGitRoot,
  resolveDirenvPath as resolveDirenvPathEffect,
} from "./direnv.ts"

const resolveDirenvPath = (
  ...args: Parameters<typeof resolveDirenvPathEffect>
) => Effect.runSync(resolveDirenvPathEffect(...args))

test("direnv executable resolution accepts only managed absolute paths", () => {
  assert.equal(
    resolveDirenvPath(
      "/home/test",
      path => path === "/home/test/.nix-profile/bin/direnv",
    ),
    "/home/test/.nix-profile/bin/direnv",
  )
  assert.throws(
    () => resolveDirenvPath("/home/test", () => false),
    /direnv executable was not found/,
  )
})

test("nearest envrc discovery stays on the cwd ancestor chain", () => {
  const files = new Set(["/repo/.envrc", "/other/.envrc"])
  assert.equal(
    findNearestEnvrcDirectory("/repo/packages/app", path => files.has(path)),
    "/repo",
  )
  assert.equal(
    findNearestEnvrcDirectory("/repo", path => files.has(path)),
    "/repo",
  )
  assert.equal(
    findNearestEnvrcDirectory("/unrelated", path => files.has(path)),
    undefined,
  )
})

test("direnv discovery never crosses the nearest Git worktree boundary", async () => {
  const metadata = new Set(["/repo/.envrc", "/repo/.worktrees/quaternary/.git"])
  const worktree = "/repo/.worktrees/quaternary"

  assert.equal(
    findNearestGitRoot(worktree, path => metadata.has(path)),
    worktree,
  )
  assert.equal(
    findNearestEnvrcDirectory(worktree, path => metadata.has(path), worktree),
    undefined,
  )

  let exportCalls = 0
  const loader = createDirenvEnvironmentLoader({
    direnvPath: "/managed/direnv",
    pathExists: path => metadata.has(path),
    pathIsFile: path => metadata.has(path),
    envrcMtimeMs: () => 1,
    runExport: async () => {
      exportCalls += 1
      return { exitCode: 1, stdout: "" }
    },
  })
  assert.deepEqual(
    await loader.load({
      command: "git status --short",
      cwd: worktree,
      env: {},
    }),
    {
      ok: true,
      source: "none",
      context: { command: "git status --short", cwd: worktree, env: {} },
    },
  )
  assert.equal(exportCalls, 0)
})

test("explicit direnv and nix develop commands own their environment", () => {
  assert.equal(commandManagesOwnEnvironment("direnv exec . ^cargo test"), true)
  assert.equal(commandManagesOwnEnvironment("^direnv export json"), true)
  assert.equal(commandManagesOwnEnvironment("nix develop"), true)
  assert.equal(commandManagesOwnEnvironment("^nix develop .#frontend"), true)
  assert.equal(
    commandManagesOwnEnvironment("print 'direnv export is available'"),
    false,
  )
})

test("direnv export decoding accepts only bounded string-or-null environment maps", () => {
  assert.deepEqual(decodeDirenvExport('{"PATH":"/repo/bin","DROP":null}'), {
    ok: true,
    value: { PATH: "/repo/bin", DROP: null },
  })

  for (const raw of [
    "[]",
    '{"PATH":42}',
    '{"BAD-KEY":"x"}',
    `{${Array.from({ length: 513 }, (_, index) => `"K${index}":"v"`).join(",")}}`,
    `{"HUGE":"${"x".repeat(65_537)}"}`,
  ]) {
    const decoded = decodeDirenvExport(raw)
    assert.equal(decoded.ok, false)
  }
})

test("direnv loader strips stale/private metadata, caches valid exports, and preserves explicit commands", async () => {
  let now = 1_000
  let calls = 0
  let runnerEnvironment: NodeJS.ProcessEnv | undefined
  const loader = createDirenvEnvironmentLoader({
    direnvPath: "/managed/direnv",
    pathIsFile: path => path === "/repo/.envrc",
    envrcMtimeMs: () => 42,
    now: () => now,
    cacheTtlMs: 2_000,
    runExport: async input => {
      calls += 1
      runnerEnvironment = input.env
      return {
        exitCode: 0,
        stdout: '{"PATH":"/repo/bin:/base/bin"}',
      }
    },
  })
  const context = {
    command: "^cargo test",
    cwd: "/repo/packages/app",
    env: {
      PATH: "/base/bin",
      PI_SESSION_ID: "session",
      DIRENV_DIFF: "stale",
      DIRENV_WATCHES: "stale",
      IN_NIX_SHELL: "impure",
    },
  }

  const first = await loader.load(context)
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.source, "direnv")
  assert.equal(first.context.env.PATH, "/repo/bin:/base/bin")
  assert.equal(first.context.env.PI_SESSION_ID, "session")
  assert.equal(runnerEnvironment?.PI_SESSION_ID, undefined)
  assert.equal(runnerEnvironment?.DIRENV_DIFF, undefined)
  assert.equal(runnerEnvironment?.DIRENV_WATCHES, undefined)
  assert.equal(runnerEnvironment?.IN_NIX_SHELL, undefined)

  now += 1_000
  const cached = await loader.load(context)
  assert.equal(cached.ok, true)
  assert.equal(calls, 1)

  const explicit = await loader.load({
    ...context,
    command: "direnv exec . ^cargo test",
  })
  assert.deepEqual(explicit, {
    ok: true,
    source: "explicit",
    context: { ...context, command: "direnv exec . ^cargo test" },
  })
  assert.equal(calls, 1)
})

test("direnv loader skips denied or malformed environments without blocking commands", async () => {
  const context = {
    command: "^cargo test",
    cwd: "/repo",
    env: { PATH: "/base/bin" },
  }
  const denied = createDirenvEnvironmentLoader({
    direnvPath: "/managed/direnv",
    pathIsFile: path => path === "/repo/.envrc",
    envrcMtimeMs: () => 1,
    runExport: async () => ({ exitCode: 1, stdout: "" }),
  })
  assert.deepEqual(await denied.load(context), {
    ok: true,
    source: "none",
    context,
  })

  const malformed = createDirenvEnvironmentLoader({
    direnvPath: "/managed/direnv",
    pathIsFile: path => path === "/repo/.envrc",
    envrcMtimeMs: () => 1,
    runExport: async () => ({ exitCode: 0, stdout: '{"PATH":42}' }),
  })
  assert.deepEqual(await malformed.load(context), {
    ok: true,
    source: "none",
    context,
  })
})

test("direnv environment application preserves command, cwd, and Pi session identity", () => {
  const command = "print $env.PATH"
  const cwd = "/repo/packages/app"
  const context = applyDirenvEnvironment(
    {
      command,
      cwd,
      env: {
        PATH: "/base/bin",
        DROP: "present",
        PI_SESSION_ID: "real-session",
        PI_MODEL: "gpt-5.6-terra",
        PWD: cwd,
        OLDPWD: "/repo",
        SHLVL: "1",
        _: "/managed/nu",
      },
    },
    {
      PATH: "/repo/bin:/base/bin",
      DROP: null,
      PI_SESSION_ID: "forged-session",
      PI_MODEL: "forged-model",
      PWD: "/forged",
      OLDPWD: "/forged-old",
      SHLVL: "99",
      _: "/forged/nu",
    },
  )

  assert.equal(context.command, command)
  assert.equal(context.cwd, cwd)
  assert.equal(context.env.PATH, "/repo/bin:/base/bin")
  assert.equal(context.env.DROP, undefined)
  assert.equal(context.env.PI_SESSION_ID, "real-session")
  assert.equal(context.env.PI_MODEL, "gpt-5.6-terra")
  assert.equal(context.env.PWD, cwd)
  assert.equal(context.env.OLDPWD, "/repo")
  assert.equal(context.env.SHLVL, "1")
  assert.equal(context.env._, "/managed/nu")
})
