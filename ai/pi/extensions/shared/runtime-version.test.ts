import assert from "node:assert/strict"
import test from "node:test"
import {
  latestRuntimeVersion,
  piHostRuntimeVersions,
} from "./runtime-version.ts"

test("reloaded runtime diagnostics keep the newest listener version", () => {
  assert.equal(latestRuntimeVersion(undefined, "2026.09.02.1"), "2026.09.02.1")
  assert.equal(
    latestRuntimeVersion("2026.09.02.2", "2026.09.02.1"),
    "2026.09.02.2",
  )
  assert.equal(
    latestRuntimeVersion("2026.09.02.2", "2026.09.02.10"),
    "2026.09.02.10",
  )
  assert.equal(latestRuntimeVersion("0.84.4", "unknown"), "0.84.4")
})

test("Pi host diagnostics distinguish package version from immutable Nix build", () => {
  assert.deepEqual(
    piHostRuntimeVersions(
      "/nix/store/sz8p6sfzw9wvzsrbw3f7xfqymx9vcjkr-pi-coding-agent-0.80.10/lib/node_modules/pi-monorepo/dist/cli.js",
    ),
    {
      "pi-host": "0.80.10",
      "pi-host-build": "sz8p6sfzw9wvzsrbw3f7xfqymx9vcjkr",
    },
  )
  assert.deepEqual(piHostRuntimeVersions(undefined), {
    "pi-host": "unknown",
    "pi-host-build": "unknown",
  })
})
