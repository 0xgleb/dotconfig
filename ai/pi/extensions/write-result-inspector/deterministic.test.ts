import assert from "node:assert/strict"
import test from "node:test"
import {
  runDeterministicChecks,
  shouldRunLuna,
  type DeterministicDependencies,
} from "./deterministic.ts"
import type { InspectionBatchFile } from "./core.ts"

const typescriptFile: InspectionBatchFile = {
  path: "src/value.ts",
  language: "typescript",
  exactChangedText: "const value = 1",
  resultingChangedText: "const value = 1",
  inspectors: ["idiomatic-typescript"],
}

const dependencies = (
  code = 0,
  symbolicLink = false,
  size = 128,
  stdout = "",
): DeterministicDependencies => ({
  cwd: "/repo",
  signal: undefined,
  lstat: async () => ({ isSymbolicLink: () => symbolicLink, size }),
  exec: async (command, args, options) => ({
    code,
    stdout,
    stderr: code === 0 ? "" : "source content must not be forwarded",
    killed: false,
    observed: { command, args, options },
  }),
})

test("clean allowlisted deterministic check permits relevant Luna inspection", async () => {
  const result = await runDeterministicChecks([typescriptFile], dependencies())
  assert.deepEqual(result, { status: "clean", skipped: [] })
  assert.equal(shouldRunLuna(result, [typescriptFile]), true)
})

test("Nushell IDE diagnostics fail only on typed error records", async () => {
  const nushellFile: InspectionBatchFile = {
    path: "scripts/check.nu",
    language: "nushell",
    exactChangedText: "let value = 1",
    resultingChangedText: "let value = 1",
    inspectors: ["idiomatic-nushell"],
  }
  const hint = JSON.stringify({ type: "hint", typename: "int" })
  const clean = await runDeterministicChecks(
    [nushellFile],
    dependencies(0, false, 128, hint),
  )
  assert.deepEqual(clean, { status: "clean", skipped: [] })

  const error = JSON.stringify({
    type: "error",
    message: "source content must not be forwarded",
  })
  const failed = await runDeterministicChecks(
    [nushellFile],
    dependencies(0, false, 128, `${hint}\n${error}`),
  )
  assert.equal(failed.status, "findings")
  if (failed.status !== "findings") return
  assert.deepEqual(failed.findings, [
    {
      source: "deterministic",
      path: "scripts/check.nu",
      inspector: "syntax",
      severity: "error",
      code: "deterministic-check-failed",
      message:
        "The configured Nushell syntax check failed for this changed file.",
    },
  ])
  assert.doesNotMatch(JSON.stringify(failed), /source content/)
})

test("deterministic failure returns a generic typed finding and prevents Luna", async () => {
  const result = await runDeterministicChecks([typescriptFile], dependencies(1))
  assert.equal(result.status, "findings")
  if (result.status !== "findings") return
  assert.deepEqual(result.findings, [
    {
      source: "deterministic",
      path: "src/value.ts",
      inspector: "format-and-syntax",
      severity: "error",
      code: "deterministic-check-failed",
      message:
        "The configured Prettier syntax/format check failed for this changed file.",
    },
  ])
  assert.doesNotMatch(JSON.stringify(result), /source content/)
  assert.equal(shouldRunLuna(result, [typescriptFile]), false)
})

test("symlink metadata fails closed before executing a checker", async () => {
  let executions = 0
  const deps = dependencies(0, true)
  const result = await runDeterministicChecks([typescriptFile], {
    ...deps,
    exec: async (...args) => {
      executions += 1
      return deps.exec(...args)
    },
  })
  assert.deepEqual(result, {
    status: "clean",
    skipped: [{ path: "src/value.ts", reason: "unsafe-symlink" }],
  })
  assert.equal(executions, 0)
  assert.equal(shouldRunLuna(result, [typescriptFile]), false)
})

test("oversized files stop before checker or model execution", async () => {
  let executions = 0
  const deps = dependencies(0, false, 1024 * 1024 + 1)
  const result = await runDeterministicChecks([typescriptFile], {
    ...deps,
    exec: async (...args) => {
      executions += 1
      return deps.exec(...args)
    },
  })
  assert.deepEqual(result, {
    status: "clean",
    skipped: [{ path: "src/value.ts", reason: "file-too-large" }],
  })
  assert.equal(executions, 0)
  assert.equal(shouldRunLuna(result, [typescriptFile]), false)
})

test("protected or escaping changed imports fail before checker or Luna", async () => {
  for (const exactChangedText of [
    '+import key from "../secrets/key"',
    '+export { value } from "../../../outside/value"',
    '+const key = require("../credentials/key")',
  ]) {
    let executions = 0
    const deps = dependencies()
    const result = await runDeterministicChecks(
      [{ ...typescriptFile, exactChangedText }],
      {
        ...deps,
        exec: async (...args) => {
          executions += 1
          return deps.exec(...args)
        },
      },
    )
    assert.equal(result.status, "findings")
    if (result.status !== "findings") continue
    assert.equal(result.findings.at(0)?.inspector, "import")
    assert.equal(result.findings.at(0)?.code, "forbidden-import")
    assert.equal(executions, 0)
    assert.equal(shouldRunLuna(result, [typescriptFile]), false)
  }
})

test("missing checker is typed unavailable and does not invent a clean model pass", async () => {
  const deps = dependencies(127)
  const result = await runDeterministicChecks([typescriptFile], deps)
  assert.deepEqual(result, {
    status: "clean",
    skipped: [{ path: "src/value.ts", reason: "checker-unavailable" }],
  })
  assert.equal(shouldRunLuna(result, [typescriptFile]), false)
})

test("aborted checks preserve the successful mutation and stop inspection", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runDeterministicChecks([typescriptFile], {
    ...dependencies(),
    signal: controller.signal,
  })
  assert.deepEqual(result, { status: "cancelled", skipped: [] })
  assert.equal(shouldRunLuna(result, [typescriptFile]), false)
})
