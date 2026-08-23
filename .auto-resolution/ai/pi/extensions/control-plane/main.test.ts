import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Effect, Either } from "effect"
import { parseControlPlaneConfig } from "./main.ts"

const codeOf = (value: unknown): string | undefined => {
  const result = Effect.runSync(Effect.either(parseControlPlaneConfig(value)))
  if (Either.isRight(result)) return undefined
  return result.left.code
}

test("control-plane config is loopback-only with a state-root database", () => {
  assert.deepEqual(
    Effect.runSync(
      parseControlPlaneConfig({
        HOME: "/Users/example",
        XDG_STATE_HOME: "/Users/example/state",
        PI_CONTROL_PLANE_PORT: "43121",
        PI_CONTROL_PLANE_DASHBOARD_DIR: "/nix/store/dashboard",
      }),
    ),
    {
      host: "127.0.0.1",
      port: 43_121,
      databasePath: "/Users/example/state/pi/control-plane/jobs.sqlite",
      home: "/Users/example",
      dashboardDirectory: "/nix/store/dashboard",
    },
  )
  assert.deepEqual(
    Effect.runSync(parseControlPlaneConfig({ HOME: "/Users/example" })),
    {
      host: "127.0.0.1",
      port: 43_121,
      databasePath: "/Users/example/.local/state/pi/control-plane/jobs.sqlite",
      home: "/Users/example",
    },
  )
})

test("control-plane startup logs the bounded typed failure", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./main.ts", import.meta.url)),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: "relative" },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid_config: HOME must be an absolute path/)
  assert.doesNotMatch(result.stderr, /stopped with an internal error/)
})

test("control-plane config rejects malformed external environment values", () => {
  assert.equal(codeOf({}), "invalid_config")
  assert.equal(codeOf({ HOME: "relative" }), "invalid_config")
  assert.equal(codeOf({ HOME: "/Users/example/" }), "invalid_config")
  assert.equal(
    codeOf({ HOME: "/Users/example", XDG_STATE_HOME: "relative" }),
    "invalid_config",
  )
  assert.equal(
    codeOf({
      HOME: "/Users/example",
      PI_CONTROL_PLANE_DASHBOARD_DIR: "relative",
    }),
    "invalid_config",
  )
  assert.equal(
    codeOf({ HOME: "/Users/example", PI_CONTROL_PLANE_PORT: "0" }),
    "invalid_config",
  )
  assert.equal(
    codeOf({ HOME: "/Users/example", PI_CONTROL_PLANE_PORT: "70000" }),
    "invalid_config",
  )
  assert.equal(
    codeOf({ HOME: "/Users/example", PI_CONTROL_PLANE_PORT: "not-a-port" }),
    "invalid_config",
  )
})
