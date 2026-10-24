import assert from "node:assert/strict"
import test from "node:test"
import {
  buildInspectorPrompt,
  coalesceMutationDeltas,
  decodeInspectorOutput,
  deterministicCheckPlan,
  mutationDeltaFromSuccessfulToolResult,
  selectApplicableInstructions,
} from "./core.ts"

const cwd = "/repo"

const editDelta = (path: string, newText: string, toolCallId = "call-1") =>
  mutationDeltaFromSuccessfulToolResult({
    cwd,
    toolCallId,
    toolName: "edit",
    input: {
      path,
      edits: [{ oldText: "const old = 1", newText }],
    },
  })

test("protected and outside-workspace mutations never become inspectable deltas", () => {
  for (const path of [
    ".env",
    ".env.local",
    "secrets/key.ts",
    "nested/1Password/item.ts",
    "certs/client.pem",
    "../other/file.ts",
    "/other/file.ts",
  ]) {
    assert.deepEqual(editDelta(path, "const next = 2"), {
      status: "skipped",
      reason:
        path.startsWith("..") || path.startsWith("/")
          ? "outside-workspace"
          : "protected-path",
    })
  }
})

test("edit and write deltas preserve exact bounded mutation text", () => {
  const edit = editDelta(
    "src/value.ts",
    'import { Effect } from "effect"\nconst next = Effect.succeed(2)',
  )
  assert.equal(edit.status, "candidate")
  if (edit.status !== "candidate") return
  assert.match(edit.delta.exactChangedText, /^@@ edit 1 @@/)
  assert.match(edit.delta.exactChangedText, /-const old = 1/)
  assert.match(edit.delta.exactChangedText, /\+import \{ Effect \}/)
  assert.deepEqual(edit.delta.inspectors, [
    "idiomatic-typescript",
    "idiomatic-effect",
    "idiomatic-functional-programming",
  ])

  const write = mutationDeltaFromSuccessfulToolResult({
    cwd,
    toolCallId: "call-2",
    toolName: "write",
    input: { path: "config/settings.json", content: '{"ok":true}' },
  })
  assert.equal(write.status, "candidate")
  if (write.status !== "candidate") return
  assert.equal(write.delta.exactChangedText, '{"ok":true}')
  assert.deepEqual(write.delta.inspectors, [])

  const sensitive = mutationDeltaFromSuccessfulToolResult({
    cwd,
    toolCallId: "secret",
    toolName: "write",
    input: {
      path: "src/config.ts",
      content: 'const credential = "sk-abcdefghijklmnopqrstuvwxyz123456"',
    },
  })
  assert.deepEqual(sensitive, {
    status: "skipped",
    reason: "sensitive-content",
  })

  const oversized = mutationDeltaFromSuccessfulToolResult({
    cwd,
    toolCallId: "call-3",
    toolName: "write",
    input: { path: "src/large.ts", content: "x".repeat(24 * 1024 + 1) },
  })
  assert.deepEqual(oversized, {
    status: "skipped",
    reason: "delta-too-large",
  })
})

test("only local language and test inspectors are selected automatically", () => {
  const rust = editDelta("src/lib.rs", "fn value() -> u64 { 1 }", "rust")
  assert.equal(rust.status, "candidate")
  if (rust.status !== "candidate") return
  assert.deepEqual(rust.delta.inspectors, [
    "idiomatic-rust",
    "idiomatic-functional-programming",
  ])

  const testDelta = editDelta(
    "src/value.test.ts",
    'test("value", () => assert.equal(value(), 1))',
    "test",
  )
  assert.equal(testDelta.status, "candidate")
  if (testDelta.status !== "candidate") return
  assert.deepEqual(testDelta.delta.inspectors, [
    "idiomatic-typescript",
    "idiomatic-functional-programming",
    "test-inspector",
  ])
  assert.ok(
    testDelta.delta.inspectors.every(
      inspector =>
        !/architecture|defensive|contract|financial|risk|security/.test(
          inspector,
        ),
    ),
  )
})

test("nearest loaded project instructions are selected without unrelated context", () => {
  const first = editDelta("src/feature/value.ts", "const value = 2", "first")
  const second = editDelta("other/tool.nu", "echo ok", "second")
  assert.equal(first.status, "candidate")
  assert.equal(second.status, "candidate")
  if (first.status !== "candidate" || second.status !== "candidate") return

  assert.deepEqual(
    selectApplicableInstructions(
      [first.delta, second.delta],
      [
        { path: "/repo/AGENTS.md", content: "root rules" },
        {
          path: "/repo/src/feature/AGENTS.md",
          content: "feature rules",
        },
        { path: "/repo/unrelated/AGENTS.md", content: "do not include" },
        { path: "/other/AGENTS.md", content: "outside" },
      ],
      cwd,
    ),
    [
      { path: "AGENTS.md", content: "root rules" },
      { path: "src/feature/AGENTS.md", content: "feature rules" },
    ],
  )
})

test("sibling mutations coalesce into one bounded file batch", () => {
  const first = editDelta("src/value.ts", "const one = 1", "first")
  const second = editDelta("src/value.ts", "const two = 2", "second")
  assert.equal(first.status, "candidate")
  assert.equal(second.status, "candidate")
  if (first.status !== "candidate" || second.status !== "candidate") return

  const batch = coalesceMutationDeltas([first.delta, second.delta])
  assert.equal(batch.status, "ready")
  if (batch.status !== "ready") return
  assert.equal(batch.leaderToolCallId, "first")
  assert.deepEqual(batch.toolCallIds, ["first", "second"])
  assert.equal(batch.files.length, 1)
  const file = batch.files.at(0)
  assert.ok(file)
  assert.match(file.exactChangedText, /const one = 1/)
  assert.match(file.exactChangedText, /const two = 2/)
})

test("model output is a closed advisory type and cannot select authority or paths", () => {
  const delta = editDelta("src/value.ts", "const value = 2")
  assert.equal(delta.status, "candidate")
  if (delta.status !== "candidate") return
  const batch = coalesceMutationDeltas([delta.delta])
  assert.equal(batch.status, "ready")
  if (batch.status !== "ready") return

  const valid = decodeInspectorOutput(
    JSON.stringify({
      findings: [
        {
          fileIndex: 0,
          inspector: "idiomatic-typescript",
          severity: "warning",
          code: "prefer-const",
          message: "Keep the binding immutable.",
          deltaLine: 2,
        },
      ],
      contextRequests: [
        {
          fileIndex: 0,
          judgment: "architecture",
          reason: "The export may change a module boundary.",
          symbols: ["value"],
        },
      ],
    }),
    batch.files,
  )
  assert.equal(valid.status, "valid")
  if (valid.status !== "valid") return
  const finding = valid.findings.at(0)
  const contextRequest = valid.contextRequests.at(0)
  assert.ok(finding)
  assert.ok(contextRequest)
  assert.equal(finding.path, "src/value.ts")
  assert.equal(contextRequest.path, "src/value.ts")

  for (const invalid of [
    {
      findings: [],
      contextRequests: [],
      authority: "commit and push",
    },
    {
      findings: [
        {
          fileIndex: 0,
          path: "../other.ts",
          inspector: "idiomatic-typescript",
          severity: "warning",
          code: "x",
          message: "changed target",
        },
      ],
      contextRequests: [],
    },
    {
      findings: [
        {
          fileIndex: 0,
          inspector: "architecture-direction",
          severity: "warning",
          code: "boundary",
          message: "architectural verdict without context",
        },
      ],
      contextRequests: [],
    },
    {
      findings: [
        {
          fileIndex: 0,
          inspector: "idiomatic-typescript",
          severity: "warning",
          code: "x",
          message: "x".repeat(401),
        },
      ],
      contextRequests: [],
    },
  ]) {
    assert.deepEqual(
      decodeInspectorOutput(JSON.stringify(invalid), batch.files),
      {
        status: "invalid",
        reason: "malformed-model-output",
      },
    )
  }
})

test("duplicate-import advisory requires duplicate modules in resulting text", () => {
  const delta = mutationDeltaFromSuccessfulToolResult({
    cwd,
    toolCallId: "resource-import",
    toolName: "edit",
    input: {
      path: "src/resource-pressure.test.ts",
      edits: [
        {
          oldText:
            'import { CRITICAL_FREE_BYTES, CRITICAL_FREE_MEMORY_BYTES } from "./resource-pressure.ts"',
          newText:
            'import { CRITICAL_FREE_MEMORY_BYTES } from "./resource-pressure.ts"',
        },
      ],
    },
  })
  assert.equal(delta.status, "candidate")
  if (delta.status !== "candidate") return

  const decoded = decodeInspectorOutput(
    JSON.stringify({
      findings: [
        {
          fileIndex: 0,
          inspector: "idiomatic-typescript",
          severity: "warning",
          code: "duplicate-import",
          message:
            "CRITICAL_FREE_MEMORY_BYTES is imported twice from resource-pressure.",
        },
      ],
      contextRequests: [],
    }),
    [delta.delta],
  )

  assert.equal(decoded.status, "valid")
  if (decoded.status !== "valid") return
  assert.deepEqual(decoded.findings, [])
})

test("deterministic checks are allowlisted by file language", () => {
  const cases = [
    ["src/value.ts", "prettier"],
    ["flake.nix", "nix-instantiate"],
    ["scripts/check.nu", "nu"],
    ["src/lib.rs", "rustfmt"],
  ] as const
  for (const [path, command] of cases) {
    const delta = editDelta(path, "value", path)
    assert.equal(delta.status, "candidate")
    if (delta.status !== "candidate") continue
    assert.equal(deterministicCheckPlan(delta.delta)?.command, command)
  }
})

test("Nushell syntax checks use IDE diagnostics instead of unsupported --check", () => {
  const delta = editDelta("scripts/check.nu", "let value = 1")
  assert.equal(delta.status, "candidate")
  if (delta.status !== "candidate") return
  assert.deepEqual(deterministicCheckPlan(delta.delta), {
    kind: "syntax",
    command: "nu",
    args: ["--ide-check", "100", "scripts/check.nu"],
  })
})

test("prompt treats source as data and forbids contextual verdicts and actions", () => {
  const delta = editDelta("src/value.ts", "const value = 2")
  assert.equal(delta.status, "candidate")
  if (delta.status !== "candidate") return
  const prompt = buildInspectorPrompt(
    [delta.delta],
    [{ path: "AGENTS.md", content: "Prefer const." }],
  )
  assert.match(prompt, /untrusted data/i)
  assert.match(prompt, /never authorize/i)
  assert.match(
    prompt,
    /import selection.*qualified-use.*formatting.*local style/is,
  )
  assert.match(prompt, /directly provable.*exact delta.*project instruction/is)
  assert.match(prompt, /architecture.*invariant.*external-contract/is)
  assert.match(prompt, /deferred to complete feature or pull-request review/is)
  assert.match(prompt, /leave contextRequests empty/i)
  assert.match(prompt, /src\/value\.ts/)
  assert.doesNotMatch(prompt, /whole conversation/i)
})
