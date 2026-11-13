import assert from "node:assert/strict"
import test from "node:test"
import { readPromptFile } from "../shared/prompt-text.ts"
import { buildClassifierPrompt } from "./lifecycle.ts"

const request = {
  boundary: "action" as const,
  intent: ["Authorized bounded work"],
  projectInstructions: "Keep unrelated work.",
  subject: { toolName: "bash", input: { command: "git commit -m fixture" } },
}

test("classifier renderer injects request guidance and resolves framework markers", () => {
  const rendered = buildClassifierPrompt(request)

  assert.ok(rendered.includes(readPromptFile("classifier-request-guidance.md")))
  assert.doesNotMatch(rendered, /\{\{(?:LINKED|MAIN)_WORKTREE_HOOKS\}\}/)
})

test("project-specific gates remain supplied context, not universal policy", () => {
  const instructions = "For this project, run cargo clippy before publication."
  const rendered = buildClassifierPrompt({
    ...request,
    projectInstructions: instructions,
  })

  assert.ok(rendered.includes(instructions))
  assert.equal(rendered.split("cargo clippy").length - 1, 1)
})

test("runtime data stays literal, including NUL and both current/retired template markers", () => {
  const subject = {
    text: "{{MAIN_WORKTREE_HOOKS}} {{LEGACY_MAIN_HOOKS}}\u0000untrusted",
  }
  const rendered = buildClassifierPrompt({
    ...request,
    subject,
    runtimeProjectContext: {
      cwd: "/fixture",
      cwdRelation: "outside-repository",
    },
  })

  assert.ok(rendered.endsWith(JSON.stringify(subject, null, 2)))
  assert.ok(!rendered.includes("\u0000"))
  assert.ok(rendered.includes("\\u0000"))
  assert.match(rendered, /"cwd": "\/fixture"/)
})
