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

test("safe unified documentation diffs may name protected files without exposing them", () => {
  const content = textContent(
    [
      "diff --git a/docs/new-instance.md b/docs/new-instance.md",
      "--- a/docs/new-instance.md",
      "+++ b/docs/new-instance.md",
      "@@ -0,0 +1 @@",
      "+Do not read credentials.json, secrets.yaml or keys.nix.",
    ].join("\n"),
  )
  assert.deepEqual(
    redactProtectedGitButlerResult({
      toolName: "bash",
      input: { command: "but diff branch-name" },
      content,
    }),
    { content, redacted: false },
  )
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

test("protected payload stays redacted across text blocks until the next file section", () => {
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "but diff" },
    content: [
      ...textContent(
        "diff --git a/keys.nix b/keys.nix\n--- a/keys.nix\n+++ b/keys.nix",
      ),
      ...textContent("@@ -1 +1 @@\n+TEST-PROTECTED-SPLIT-PAYLOAD"),
      ...textContent(
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n+safe docs",
      ),
    ],
  })
  assert.equal(result.redacted, true)
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /TEST-PROTECTED-SPLIT-PAYLOAD/,
  )
  assert.match(JSON.stringify(result.content), /safe docs/)
})

test("a recognized safe section cannot hide a later malformed protected section", () => {
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "but diff" },
    content: textContent(
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n+safe docs\nchanged file keys.nix\nTEST-MALFORMED-PROTECTED-PAYLOAD",
    ),
  })
  assert.equal(result.redacted, true)
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /TEST-MALFORMED-PROTECTED-PAYLOAD/,
  )
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

test("ambiguous fallback preserves nontext content and order", () => {
  const image = { type: "image" as const, data: "AA==", mimeType: "image/png" }
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "but diff" },
    content: [
      ...textContent("changed file keys.nix\nTEST-AMBIGUOUS-PAYLOAD"),
      image,
    ],
  })
  assert.equal(result.redacted, true)
  assert.equal(result.content[1], image)
  assert.doesNotMatch(JSON.stringify(result.content), /TEST-AMBIGUOUS-PAYLOAD/)
})

test("counted hunk data cannot reopen a section through header-like additions", () => {
  const content = textContent(
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -0,0 +1,2 @@\n+++ b/keys.nix\n+diff --git a/keys.nix b/keys.nix",
  )
  assert.deepEqual(
    redactProtectedGitButlerResult({
      toolName: "bash",
      input: { command: "but diff" },
      content,
    }),
    { content, redacted: false },
  )
})

test("incomplete hunks naming protected paths fail closed", () => {
  for (const header of ["@@ -0,0 +1,2 @@", "@@ -0,0 +1,9007199254740992 @@"]) {
    const result = redactProtectedGitButlerResult({
      toolName: "bash",
      input: { command: "but diff" },
      content: textContent(
        `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n${header}\n+Reference keys.nix`,
      ),
    })
    assert.equal(result.redacted, true)
    assert.match(
      JSON.stringify(result.content),
      /unrecognized protected diff format withheld/,
    )
  }
})

test("malformed protected headers never retain trailing payload", () => {
  for (const line of [
    "diff --git a/keys.nix b/keys.nix SYNTHETIC-PAYLOAD",
    "--- a/keys.nix SYNTHETIC-PAYLOAD",
  ]) {
    const result = redactProtectedGitButlerResult({
      toolName: "bash",
      input: { command: "but diff" },
      content: textContent(line),
    })
    assert.equal(result.redacted, true)
    assert.doesNotMatch(JSON.stringify(result.content), /SYNTHETIC-PAYLOAD/)
  }
})

test("fragmented protected pathname headers cannot expose their payload", () => {
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "but diff" },
    content: [
      "diff --",
      "git a/keys.",
      "nix b/keys.",
      "nix\n+SYNTHETIC-PAYLOAD",
    ].flatMap(textContent),
  })
  assert.equal(result.redacted, true)
  assert.doesNotMatch(JSON.stringify(result.content), /SYNTHETIC-PAYLOAD/)
})

test("unresolved C-quoted pathname encodings remain fail closed", () => {
  const result = redactProtectedGitButlerResult({
    toolName: "bash",
    input: { command: "but diff" },
    content: textContent(String.raw`diff --git "a/\153eys.nix" "b/\153eys.nix"
--- "a/\153eys.nix"
+++ "b/\153eys.nix"
@@ -0,0 +1 @@
+SYNTHETIC-PAYLOAD`),
  })
  assert.equal(result.redacted, true)
  assert.doesNotMatch(JSON.stringify(result.content), /SYNTHETIC-PAYLOAD/)
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
