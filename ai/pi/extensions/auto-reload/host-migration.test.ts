import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  HOST_MIGRATION_DRAFT_ENV,
  HOST_MIGRATION_RESUME_ENV,
  hostMigrationArgv,
  hostMigrationEnvironment,
  isInteractiveHostRuntime,
  needsManagedHostMigration,
  verifiedHostArtifacts,
} from "./host-migration.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

test("an old interactive host without reload-context mode metadata remains migratable", () => {
  assert.equal(
    isInteractiveHostRuntime({
      mode: undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    true,
  )
  assert.equal(
    isInteractiveHostRuntime({
      mode: undefined,
      stdinIsTTY: false,
      stdoutIsTTY: true,
    }),
    false,
  )
  assert.equal(
    isInteractiveHostRuntime({
      mode: "rpc",
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    false,
  )
})

test("a running old Nix host migrates to the stable verified host in place", () => {
  assert.equal(
    needsManagedHostMigration({
      currentEntrypoint:
        "/nix/store/old-pi/lib/node_modules/pi-monorepo/dist/cli.js",
      stableEntrypoint: "/nix/store/new-pi/bin/pi",
    }),
    true,
  )
  assert.equal(
    needsManagedHostMigration({
      currentEntrypoint:
        "/nix/store/new-pi/lib/node_modules/pi-monorepo/dist/cli.js",
      stableEntrypoint: "/nix/store/new-pi/bin/pi",
    }),
    false,
  )
  assert.equal(
    needsManagedHostMigration({
      currentEntrypoint: "/Users/dev/pi/dist/cli.js",
      stableEntrypoint: "/nix/store/new-pi/bin/pi",
    }),
    false,
  )

  assert.equal(
    verifiedHostArtifacts({
      launcher: "exec /nix/store/new-pi/bin/.pi-wrapped",
      expectedWrappedEntrypoint: "/nix/store/new-pi/bin/.pi-wrapped",
      tui: "renderSafely() { this.renderSafely(); }",
      mainScreen: "const pending = [root];",
    }),
    true,
  )
  assert.equal(
    verifiedHostArtifacts({
      launcher: "exec /nix/store/new-pi/bin/.pi-wrapped",
      expectedWrappedEntrypoint: "/nix/store/new-pi/bin/.pi-wrapped",
      tui: "doRender()",
      mainScreen: "return rootContains(root, target)",
    }),
    false,
  )

  assert.deepEqual(
    hostMigrationArgv("/nix/store/new-pi/bin/pi", "/sessions/current.jsonl"),
    ["/nix/store/new-pi/bin/pi", "--session", "/sessions/current.jsonl"],
  )
  assert.deepEqual(
    hostMigrationEnvironment(
      { KEEP: "yes", OMIT: undefined },
      "unfinished draft",
      true,
    ),
    {
      KEEP: "yes",
      [HOST_MIGRATION_DRAFT_ENV]: "unfinished draft",
      [HOST_MIGRATION_RESUME_ENV]: "1",
    },
  )
  assert.deepEqual(hostMigrationEnvironment({ KEEP: "yes" }, "", false), {
    KEEP: "yes",
    [HOST_MIGRATION_DRAFT_ENV]: "",
  })
})

test("activated host changes are polled even without a managed source event", () => {
  assert.match(
    extensionSource,
    /generationTimer = setInterval\(\(\) => \{[\s\S]*?resolveHostMigrationPlan\(ctx\)[\s\S]*?scheduleHostMigration\(ctx, hostMigrationPlan\)/,
  )
})

test("auto reload defers in-place host migration until idle and restores the composer", () => {
  assert.match(extensionSource, /realpathSync\(stablePiPath\)/)
  assert.match(extensionSource, /process\.argv\[1\]/)
  assert.match(extensionSource, /isInteractiveHostRuntime/)
  assert.match(extensionSource, /verifiedHostArtifacts/)
  assert.match(extensionSource, /ctx\.sessionManager\.getSessionFile\(\)/)
  assert.match(extensionSource, /ctx\.ui\.getEditorText\(\)/)
  assert.match(extensionSource, /ctx\.hasPendingMessages\(\)/)
  assert.match(extensionSource, /ctx\.isIdle\(\)/)
  assert.match(
    extensionSource,
    /sessionStartActive \|\|[\s\S]*?!ctx\.isIdle\(\)[\s\S]*?ctx\.ui\.getEditorText\(\)\.length > 0/,
  )
  assert.match(extensionSource, /process\.execve/)
  assert.match(extensionSource, /hostMigrationArgv/)
  assert.match(extensionSource, /hostMigrationEnvironment/)
  assert.match(extensionSource, /ctx\.ui\.setEditorText\(editorDraft\)/)
  assert.match(
    extensionSource,
    /delete process\.env\[HOST_MIGRATION_DRAFT_ENV\]/,
  )
  assert.match(
    extensionSource,
    /delete process\.env\[HOST_MIGRATION_RESUME_ENV\]/,
  )
  assert.match(
    extensionSource,
    /pi\.sendMessage[\s\S]*?Resuming preserved work after Pi host migration/,
  )
  assert.match(
    extensionSource,
    /pi\.sendMessage\([\s\S]*?auto-reload\.host-migrated[\s\S]*?\)[\s\S]*?recordHostMigrationDelivery\(delivery, branch\)/,
  )
  assert.doesNotMatch(
    extensionSource,
    /recordHostMigrationDelivery\(delivery, branch\)[\s\S]{0,500}?pi\.sendMessage\([\s\S]*?auto-reload\.host-migrated/,
  )
  assert.match(extensionSource, /clearTimeout\(hostMigrationTimer\)/)
  const preflight = extensionSource.indexOf("if (!isReloadableContext(ctx))")
  const migration = extensionSource.indexOf(
    "if (hostMigrationPlan) scheduleHostMigration(ctx, hostMigrationPlan)",
  )
  assert.ok(migration > 0)
  assert.ok(migration < preflight)
})
