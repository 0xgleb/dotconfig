import assert from "node:assert/strict"
import { channel } from "node:diagnostics_channel"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  RequestLifecyclePhase,
  installRequestLifecycleLogging,
  requestLifecycleLogPath,
  safeLifecycleEvent,
  type RequestLifecycleEvent,
} from "./core.ts"

test("request lifecycle log path is explicit and process-scoped", () => {
  assert.equal(
    requestLifecycleLogPath("/state", "/home/operator", 99754),
    "/state/pi/logs/request-lifecycle-99754.jsonl",
  )
  assert.equal(
    requestLifecycleLogPath(undefined, "/home/operator", 21231),
    "/home/operator/.local/state/pi/logs/request-lifecycle-21231.jsonl",
  )
})

test("Effect logging writes queryable JSON and drops unsafe channel messages", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-request-observability-"))
  const logPath = join(directory, "request.jsonl")
  const lifecycleChannel = channel(`pi.request.lifecycle.test.${process.pid}`)
  const uninstall = installRequestLifecycleLogging(lifecycleChannel, logPath)
  try {
    lifecycleChannel.publish({
      schemaVersion: 1,
      signal: "pi.provider.phase",
      phase: RequestLifecyclePhase.TransportStarted,
      requestId: "request-id",
      timestamp: 1_787_277_600_000,
      elapsedMs: 91,
      pid: 99754,
      project: "st0x",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    })
    lifecycleChannel.publish({
      schemaVersion: 1,
      signal: "pi.provider.phase",
      phase: RequestLifecyclePhase.TransportStarted,
      requestId: "unsafe-request",
      timestamp: 1_787_277_600_001,
      elapsedMs: 92,
      pid: 99754,
      project: "st0x",
      headers: { authorization: "secret" },
    })

    const lines = readFileSync(logPath, "utf8").trim().split("\n")
    assert.equal(lines.length, 1)
    const logged = JSON.parse(lines[0]) as {
      readonly message: unknown
      readonly annotations: Record<string, unknown>
    }
    assert.equal(logged.message, "pi.provider.phase")
    assert.equal(logged.annotations.phase, "provider.transport.started")
    assert.equal(logged.annotations.requestId, "request-id")
    assert.equal(logged.annotations.elapsedMs, 91)
    assert.equal(JSON.stringify(logged).includes("authorization"), false)
  } finally {
    uninstall()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("request lifecycle events expose only the bounded diagnostic schema", () => {
  const event = safeLifecycleEvent({
    schemaVersion: 1,
    signal: "pi.auth.phase",
    phase: RequestLifecyclePhase.AuthLockWait,
    requestId: "0195f50d-8a65-7e32-b72a-82f49b774c8f",
    timestamp: 1_787_277_600_000,
    elapsedMs: 42,
    pid: 99754,
    project: "st0x",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  })

  assert.deepEqual(event, {
    schemaVersion: 1,
    signal: "pi.auth.phase",
    phase: RequestLifecyclePhase.AuthLockWait,
    requestId: "0195f50d-8a65-7e32-b72a-82f49b774c8f",
    timestamp: 1_787_277_600_000,
    elapsedMs: 42,
    pid: 99754,
    project: "st0x",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  })
  assert.deepEqual(Object.keys(event).sort(), [
    "elapsedMs",
    "model",
    "phase",
    "pid",
    "project",
    "provider",
    "requestId",
    "schemaVersion",
    "signal",
    "timestamp",
  ])
})

test("request lifecycle validation rejects payload and credential-shaped fields", () => {
  const unsafe = {
    schemaVersion: 1,
    signal: "pi.request.phase",
    phase: RequestLifecyclePhase.RequestStarted,
    requestId: "request-id",
    timestamp: Date.now(),
    elapsedMs: 0,
    pid: process.pid,
    project: "st0x",
    payload: { input: "secret prompt" },
    accessToken: "secret",
  }

  assert.equal(safeLifecycleEvent(unsafe), undefined)
})

test("request lifecycle validation rejects unknown phases and failure classes", () => {
  const base: RequestLifecycleEvent = {
    schemaVersion: 1,
    signal: "pi.request.outcome",
    phase: RequestLifecyclePhase.RequestFailed,
    requestId: "request-id",
    timestamp: Date.now(),
    elapsedMs: 5,
    pid: process.pid,
    project: "st0x",
    outcome: "failed",
    failureClass: "unknown",
  }

  assert.ok(safeLifecycleEvent(base))
  assert.equal(safeLifecycleEvent({ ...base, phase: "made-up" }), undefined)
  assert.equal(
    safeLifecycleEvent({ ...base, failureClass: "raw provider message" }),
    undefined,
  )
})
