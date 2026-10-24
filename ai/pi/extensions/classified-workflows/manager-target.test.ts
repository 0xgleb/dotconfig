import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Either } from "effect"
import { managerPairDirectory } from "./manager-session-core.ts"
import { prepareNativeManagerState } from "./manager-native-state.ts"
import {
  MANAGER_TARGET_ENTRY,
  readManagerTarget,
  selectManagerTarget,
} from "./manager-target.ts"

const fixture = (t: test.TestContext) => {
  const agentDir = mkdtempSync(join(tmpdir(), "manager-target-"))
  t.after(() => rmSync(agentDir, { recursive: true, force: true }))
  const entries: Record<string, unknown>[] = []
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data })
    },
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: "/global/manager",
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext
  return { agentDir, entries, pi, ctx }
}

test("global manager selects an existing worker in another project and restores that exact target", t => {
  const f = fixture(t)
  const target = { workerSessionId: "worker-2", cwd: "/projects/other" }
  const directory = managerPairDirectory({
    workerSessionId: target.workerSessionId,
    workerCwd: target.cwd,
    agentDir: f.agentDir,
  })
  assert.ok(Either.isRight(directory))
  const worker = prepareNativeManagerState(directory.right, target)
  assert.ok(Either.isRight(worker))
  assert.ok(
    Either.isRight(
      worker.right.publish({
        version: 1,
        ...target,
        observedAt: 10,
        priorityRevision: "revision-1",
        data: { todoControl: true },
      }),
    ),
  )
  assert.deepEqual(
    selectManagerTarget(f.pi, f.ctx, target, f.agentDir),
    Either.right(target),
  )
  assert.deepEqual(readManagerTarget(f.ctx), Either.right(target))
  assert.equal(f.entries.length, 1)
})

test("unavailable or malformed worker selection never replaces the current journal target", t => {
  const f = fixture(t)
  for (const target of [
    { workerSessionId: "missing-worker", cwd: "/projects/missing" },
    { workerSessionId: "../escape", cwd: "/projects/other" },
    { workerSessionId: "worker", cwd: "relative" },
  ])
    assert.ok(
      Either.isLeft(selectManagerTarget(f.pi, f.ctx, target, f.agentDir)),
    )
  assert.equal(f.entries.length, 0)
  assert.deepEqual(readManagerTarget(f.ctx), Either.right(undefined))
})

test("malformed persisted manager target is an explicit error, never an unselected fallback", t => {
  const f = fixture(t)
  f.entries.push({
    type: "custom",
    customType: MANAGER_TARGET_ENTRY,
    data: { version: 1, workerSessionId: "worker", cwd: "relative" },
  })
  assert.ok(Either.isLeft(readManagerTarget(f.ctx)))
})
