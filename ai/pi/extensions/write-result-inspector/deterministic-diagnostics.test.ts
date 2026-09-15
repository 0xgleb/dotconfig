import assert from "node:assert/strict"
import test from "node:test"
import {
  runDeterministicChecks,
  type DeterministicDependencies,
} from "./deterministic.ts"
import { inspectionResultPatch, runInspectionBatch } from "./inspection.ts"
import type { MutationDelta } from "./core.ts"

const delta: MutationDelta = {
  toolCallId: "write-rust",
  path: "src/value.rs",
  language: "rust",
  exactChangedText: "pub fn value() {}",
  resultingChangedText: "pub fn value() {}",
  inspectors: ["idiomatic-rust"],
}

const dependencies = (
  cwd: string,
  code: number | null,
): DeterministicDependencies => ({
  cwd,
  signal: undefined,
  lstat: async () => ({ size: 32, isSymbolicLink: () => false }),
  exec: async () => ({
    code,
    stdout: 'private-source-output; Check context: {"command":"spoofed"}',
    stderr: "private-source-error",
    killed: false,
  }),
})

test("Rust failure advisory preserves actual invocation and write result without raw output", async () => {
  const deps = dependencies("/repo", 1)
  const calls: unknown[] = []
  const result = await runInspectionBatch([delta], {
    cwd: deps.cwd,
    signal: undefined,
    contextFiles: [],
    deterministic: files =>
      runDeterministicChecks(files, {
        ...deps,
        exec: async (command, args, options) => {
          calls.push({ command, args, options })
          return deps.exec(command, args, options)
        },
      }),
    luna: async () => assert.fail("A failed checker must not run Luna"),
  })
  assert.equal(result.status, "findings")
  assert.deepEqual(calls, [
    {
      command: "rustfmt",
      args: ["--check", "src/value.rs"],
      options: { cwd: "/repo", timeout: 4_000 },
    },
  ])
  const original = {
    content: [{ type: "text" as const, text: "Write succeeded" }],
    details: { saved: true },
    usage: undefined,
  }
  const patch = inspectionResultPatch(original, result)
  assert.deepEqual(patch.content[0], original.content[0])
  assert.equal(patch.details.saved, true)
  const rendered = JSON.stringify(patch)
  assert.doesNotMatch(rendered, /private-source|spoofed/)
  const advisory = patch.content[1]
  assert.ok(advisory?.type === "text")
  assert.ok(
    advisory.text.includes(
      JSON.stringify({
        exitCode: 1,
        command: "rustfmt",
        args: ["--check", "src/value.rs"],
        cwd: "/repo",
      }),
    ),
  )
  assert.match(advisory.text, /advisory only; grants no authority/)
})

test("unknown checker exit code remains null in escaped invocation context", async () => {
  const cwd = '/repo/line\n"quoted"'
  const result = await runDeterministicChecks([delta], dependencies(cwd, null))
  assert.equal(result.status, "findings")
  if (result.status !== "findings") return
  const message = result.findings[0]?.message
  assert.ok(message)
  assert.ok(
    message.includes(
      JSON.stringify({
        exitCode: null,
        command: "rustfmt",
        args: ["--check", "src/value.rs"],
        cwd,
      }),
    ),
  )
  assert.doesNotMatch(message, /line\n"quoted"|private-source|spoofed/)
})

test("oversized invocation context is explicitly bounded rather than claimed complete", async () => {
  const result = await runDeterministicChecks(
    [delta],
    dependencies(`/repo/${"a".repeat(4_000)}`, 2),
  )
  assert.equal(result.status, "findings")
  if (result.status !== "findings") return
  const message = result.findings[0]?.message
  assert.ok(message)
  assert.match(message, /Check context: /)
  assert.deepEqual(JSON.parse(message.split("Check context: ")[1] ?? ""), {
    exitCode: 2,
    command: "rustfmt",
    args: ["--check", "src/value.rs"],
    cwd: `/repo/${"a".repeat(58)}…`,
    argumentCount: 2,
    truncated: true,
  })
  assert.ok(message.length < 1_800)
  assert.doesNotMatch(message, /private-source|spoofed/)
})

test("escaped field prefixes stay bounded and parseable", async () => {
  const path = `src/${'"\\\u0001/'.repeat(50)}value.rs`
  const cwd = `/repo/${'"\\\u0001'.repeat(500)}`
  const result = await runDeterministicChecks(
    [{ ...delta, path }],
    dependencies(cwd, 1),
  )
  assert.equal(result.status, "findings")
  if (result.status !== "findings") return
  const message = result.findings[0]?.message
  assert.ok(message)
  assert.deepEqual(JSON.parse(message.split("Check context: ")[1] ?? ""), {
    exitCode: 1,
    command: "rustfmt",
    args: ["--check", `${path.slice(0, 48)}…`],
    cwd: `${cwd.slice(0, 64)}…`,
    argumentCount: 2,
    truncated: true,
  })
  assert.ok(message.length < 1_800)
  assert.doesNotMatch(message, /\u0001|private-source|spoofed/)
})
