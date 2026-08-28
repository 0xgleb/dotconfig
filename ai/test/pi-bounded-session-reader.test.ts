import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  loadBoundedSessionEntriesSync,
  MAX_SESSION_ENTRY_BYTES,
  MAX_SESSION_LOAD_BYTES,
} from "../pi/host/bounded-session-reader.js"

const sessionEntry = (entry: unknown): string => `${JSON.stringify(entry)}\n`

const parseLoaderSummary = (raw: string) => {
  const value: unknown = JSON.parse(raw)
  assert.ok(typeof value === "object" && value !== null)
  assert.ok("count" in value)
  assert.equal(typeof value.count, "number")
  assert.ok("firstType" in value)
  assert.ok(value.firstType === null || typeof value.firstType === "string")
  assert.ok("lastId" in value)
  assert.ok(value.lastId === null || typeof value.lastId === "string")
  assert.ok("secondCustomType" in value)
  assert.ok(
    value.secondCustomType === null ||
      typeof value.secondCustomType === "string",
  )
  assert.ok("secondId" in value)
  assert.ok(value.secondId === null || typeof value.secondId === "string")
  assert.ok("thirdParentId" in value)
  assert.ok(
    value.thirdParentId === null || typeof value.thirdParentId === "string",
  )
  return {
    count: value.count,
    firstType: value.firstType,
    lastId: value.lastId,
    secondCustomType: value.secondCustomType,
    secondId: value.secondId,
    thirdParentId: value.thirdParentId,
  }
}

const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
const flake = readFileSync(new URL("../../flake.nix", import.meta.url), "utf8")

test("oversized command output cannot exhaust the Pi session loader", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-bounded-session-reader-"))
  const sessionFile = join(directory, "session.jsonl")
  try {
    const header = {
      type: "session",
      version: 3,
      id: "session-id",
      timestamp: "2026-08-28T00:00:00.000Z",
      cwd: "/Users/0xgleb/.config",
    }
    const toolCall = {
      type: "message",
      id: "tool-call-id",
      parentId: null,
      timestamp: "2026-08-28T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "bash-call-id",
            name: "bash",
            arguments: { command: "nix store gc" },
          },
        ],
      },
    }
    const oversizedToolResult = {
      type: "message",
      id: "tool-result-id",
      parentId: "tool-call-id",
      timestamp: "2026-08-28T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "bash-call-id",
        toolName: "bash",
        content: [
          {
            type: "text",
            text: `deleting '/nix/store/example-source'\n${"x".repeat(MAX_SESSION_ENTRY_BYTES)}`,
          },
        ],
      },
    }
    const assistant = {
      type: "message",
      id: "assistant-id",
      parentId: "tool-result-id",
      timestamp: "2026-08-28T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Build finished." }],
      },
    }
    writeFileSync(
      sessionFile,
      sessionEntry(header) +
        sessionEntry(toolCall) +
        sessionEntry(oversizedToolResult) +
        sessionEntry(assistant),
    )

    const entries = loadBoundedSessionEntriesSync(sessionFile)
    assert.equal(entries.length, 4)
    assert.deepEqual(entries[0], header)
    assert.deepEqual(entries[1], toolCall)
    assert.deepEqual(entries[3], assistant)
    assert.deepEqual(entries[2], {
      type: "custom_message",
      id: "tool-result-id",
      parentId: "tool-call-id",
      timestamp: "2026-08-28T00:00:02.000Z",
      customType: "oversized_session_entry",
      content: [
        {
          type: "text",
          text: `[Session entry omitted: exceeded ${MAX_SESSION_ENTRY_BYTES}-byte safety limit]`,
        },
      ],
      display: true,
      details: {
        originalType: "message",
        maxEntryBytes: MAX_SESSION_ENTRY_BYTES,
      },
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an oversized malformed final entry is discarded without losing the session", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-bounded-session-reader-"))
  const sessionFile = join(directory, "session.jsonl")
  try {
    const header = {
      type: "session",
      version: 3,
      id: "session-id",
      timestamp: "2026-08-28T00:00:00.000Z",
      cwd: "/Users/0xgleb/.config",
    }
    writeFileSync(
      sessionFile,
      sessionEntry(header) + "x".repeat(MAX_SESSION_ENTRY_BYTES + 1),
    )

    assert.deepEqual(loadBoundedSessionEntriesSync(sessionFile), [header])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the production session loader survives a multi-row session larger than its heap", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-bounded-session-reader-"))
  const sessionFile = join(directory, "session.jsonl")
  const entryCount = 160
  try {
    writeFileSync(
      sessionFile,
      sessionEntry({
        type: "session",
        version: 3,
        id: "session-id",
        timestamp: "2026-08-28T00:00:00.000Z",
        cwd: "/Users/0xgleb/.config",
      }),
    )
    const payload = "x".repeat(1024 * 1024)
    for (let index = 0; index < entryCount; index += 1) {
      appendFileSync(
        sessionFile,
        sessionEntry({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: "2026-08-28T00:00:01.000Z",
          message: {
            role: "toolResult",
            toolCallId: `call-${index}`,
            toolName: "bash",
            content: [{ type: "text", text: payload }],
          },
        }),
      )
    }

    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        new URL("./fixtures/bounded-session-loader.mjs", import.meta.url)
          .pathname,
        sessionFile,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    )

    assert.equal(result.status, 0, result.stderr)
    const summary = parseLoaderSummary(result.stdout)
    assert.equal(summary.firstType, "session")
    assert.equal(summary.secondCustomType, "truncated_session_history")
    assert.notEqual(summary.secondId, null)
    assert.equal(summary.thirdParentId, summary.secondId)
    assert.equal(summary.lastId, `entry-${entryCount - 1}`)
    assert.ok(summary.count <= MAX_SESSION_LOAD_BYTES / (1024 * 1024) + 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the installed Pi host includes the bounded session reader regression", () => {
  assert.match(home, /host\/bounded-session-reader\.js/u)
  assert.match(home, /patches\/bounded-session-reader\.patch/u)
  assert.match(home, /MAX_SESSION_LOAD_BYTES = 32 \* 1024 \* 1024/u)
  assert.match(home, /bounded session entry loading missing/u)
  assert.match(
    flake,
    /node --test ai\/test\/pi-bounded-session-reader\.test\.ts/u,
  )
})
