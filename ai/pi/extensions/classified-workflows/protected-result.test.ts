import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { redactProtectedGitButlerResult } from "./protected-result.ts"

const textContent = (text: string) => [{ type: "text" as const, text }]

test("GitButler diff results redact protected sections before classification", () => {
  const protectedCiphertext = "AGE-ENCRYPTED-TEST-PLACEHOLDER"
  const protectedKey = "ssh-ed25519 TEST-KEY-PLACEHOLDER"
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "but diff" },
    content: textContent(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-old safe value",
        "+new safe value",
        "diff --git a/infra/production.age b/infra/production.age",
        "--- a/infra/production.age",
        "+++ b/infra/production.age",
        "@@ -1 +1 @@",
        `+${protectedCiphertext}`,
        "diff --git a/keys.nix b/keys.nix",
        "--- a/keys.nix",
        "+++ b/keys.nix",
        "@@ -1 +1 @@",
        `+${protectedKey}`,
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "+safe documentation",
      ].join("\n"),
    ),
  })

  assert.equal(result.redacted, true)
  const serialized = JSON.stringify(result.content)
  assert.match(serialized, /new safe value/)
  assert.match(serialized, /safe documentation/)
  assert.match(serialized, /protected diff payload redacted/)
  assert.doesNotMatch(serialized, new RegExp(protectedCiphertext))
  assert.doesNotMatch(serialized, new RegExp(protectedKey))
})

test("redaction recognizes explicit GitButler project selection", () => {
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "^but -C /workspace diff branch-name" },
    content: textContent(
      [
        "diff --git a/secrets/token.json b/secrets/token.json",
        "--- a/secrets/token.json",
        "+++ b/secrets/token.json",
        "@@ -1 +1 @@",
        "+TEST-PROTECTED-VALUE",
      ].join("\n"),
    ),
  })

  assert.equal(result.redacted, true)
  assert.doesNotMatch(JSON.stringify(result.content), /TEST-PROTECTED-VALUE/)
})

test("unrecognized GitButler diff formats fail closed when protected paths appear", () => {
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "but diff branch-name" },
    content: textContent(
      "changed file keys.nix\nTEST-PROTECTED-CUSTOM-FORMAT-PAYLOAD",
    ),
  })

  assert.equal(result.redacted, true)
  const serialized = JSON.stringify(result.content)
  assert.match(serialized, /unrecognized protected diff format withheld/)
  assert.doesNotMatch(serialized, /TEST-PROTECTED-CUSTOM-FORMAT-PAYLOAD/)
})

test("ordinary status and non-GitButler results remain byte-for-byte unchanged", () => {
  const content = textContent("keys.nix\ninfra/production.age")
  for (const request of [
    { toolName: "bash", input: { command: "but status -fv" }, content },
    { toolName: "bash", input: { command: "git diff --stat" }, content },
    { toolName: "read", input: { path: "README.md" }, content },
  ]) {
    assert.deepEqual(redactProtectedGitButlerResult(request), {
      content,
      redacted: false,
    })
  }
})

test("tool-result middleware sanitizes before any classifier input", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = source.indexOf('pi.on("tool_result"')
  const end = source.indexOf(
    'pi.registerTool({\n    name: "review_duty"',
    start,
  )
  assert.ok(start >= 0 && end > start)
  const handler = source.slice(start, end)
  assert.ok(
    handler.indexOf("redactProtectedGitButlerResult") <
      handler.indexOf("classifyWithActivity"),
  )
  assert.match(handler, /toolResultSubject\(event, protectedResult\.content\)/)
  assert.match(handler, /return protectedPatch/)
})
