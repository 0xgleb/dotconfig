import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import { buildClassifierPrompt } from "./lifecycle.ts"

const normalize = (value: string) =>
  value
    .replace(/^#{1,6} .*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim()
const request = {
  boundary: "action" as const,
  intent: ["Owner-authorized bounded work"],
  projectInstructions: "Keep unrelated work.",
  subject: { toolName: "bash", input: { command: "git commit -m fixture" } },
}
const expected = JSON.parse(
  readFileSync(
    new URL("./classifier-policy-fingerprints.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>

test("classifier starting policy is a canonical reviewable Markdown asset", () => {
  assert.ok(
    existsSync(new URL("../../prompts/classifier-policy.md", import.meta.url)),
  )
  const source = readFileSync(
    new URL("./lifecycle.ts", import.meta.url),
    "utf8",
  )
  assert.ok(
    !source.includes(
      "You are a fail-closed safety classifier for an AI coding agent.",
    ),
    "do not retain an inline duplicate",
  )
})
for (const mode of ["off", "shadow", "enforce"] as const)
  test(`Markdown migration preserves every policy word except the owner-deleted paragraph (${mode})`, () => {
    const rendered = buildClassifierPrompt({
      ...request,
      gitHookAuthorityMode: mode,
    })
    assert.equal(
      createHash("sha256").update(normalize(rendered)).digest("hex"),
      expected[mode],
    )
    assert.doesNotMatch(rendered, /A changed-file manifest identifies the diff/)
    assert.match(rendered, /protected|credential/)
    assert.doesNotMatch(rendered, /\{\{LEGACY_(?:LINKED|MAIN)_HOOKS\}\}/)
  })

test("runtime input remains literal data, including NUL escaping and apparent template markers", () => {
  const rendered = buildClassifierPrompt({
    ...request,
    subject: { text: "{{LEGACY_MAIN_HOOKS}}\u0000untrusted" },
    runtimeProjectContext: {
      cwd: "/fixture",
      cwdRelation: "outside-repository",
    },
  })
  assert.ok(
    rendered.includes("{{LEGACY_MAIN_HOOKS}}"),
    "only trusted base markers may be substituted",
  )
  assert.ok(!rendered.includes("\u0000"))
  assert.ok(rendered.includes("\\u0000"))
  assert.match(rendered, /"cwd": "\/fixture"/)
})
