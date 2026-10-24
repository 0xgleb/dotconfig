import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { deterministicDecision } from "../pi/extensions/classified-workflows/core.ts"
import { buildClassifierPrompt } from "../pi/extensions/classified-workflows/lifecycle.ts"
import { eodSessionSearchDisprovesMissingQuestionScopeBlock } from "../pi/extensions/classified-workflows/intent-context.ts"

test("persistent-memory operations are prohibited, not read-only exceptions", () => {
  for (const toolName of [
    "memory",
    "memory_search",
    "session_search",
    "functions.memory",
    "functions.session_search",
  ]) {
    const decision = deterministicDecision({
      boundary: "action",
      toolName,
      input: { action: "add", query: "prior work" },
      cwd: "/repo",
    })
    assert.equal(decision?.verdict, "block", toolName)
    assert.match(decision?.reason ?? "", /persistent.memory.*prohibited/i)
  }
})

test("classifier never encourages memory writes or retrieval", () => {
  const prompt = buildClassifierPrompt({
    boundary: "action",
    intent: ["Continue assigned work"],
    projectInstructions: "No persistent memory",
    subject: { toolName: "read", input: { path: "AGENTS.md" } },
  })
  assert.doesNotMatch(
    prompt,
    /narrowly scoped memory add|accurate memory record|bounded memory\/session history|successful current memory_search|proposed memory itself/i,
  )
  assert.match(prompt, /persistent.memory.*prohibited/i)
})

test("retired retrieval compatibility surface cannot restore historical authority", () => {
  assert.equal(
    eodSessionSearchDisprovesMissingQuestionScopeBlock({
      reason: "No active EOD request",
      branch: [],
      toolName: "ask_user",
      input: { action: "ask", question: "EOD start boundary?" },
      cwd: "/repo",
    }),
    false,
  )
  const source = readFileSync(
    new URL(
      "../pi/extensions/classified-workflows/intent-context.ts",
      import.meta.url,
    ),
    "utf8",
  )
  assert.doesNotMatch(source, /searchCallIds|SESSION_SEARCH_USER_RESULT/)
})

test("EOD uses current evidence rather than persistent session retrieval", () => {
  const source = readFileSync(
    new URL("../skills/eod/SKILL.md", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(
    source,
    /session_search|SessionSearch|Recover framing from Pi sessions/,
  )
  assert.match(source, /current conversation/i)
})
