import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"
import { Either } from "effect"
import {
  parseGitHookAuthorityMode,
  registerGitHookAuthority,
  type GitHookAuthorityFlags,
} from "./hook-authority.ts"
import {
  buildClassifierPrompt,
  type ClassificationRequest,
} from "./lifecycle.ts"

const request: ClassificationRequest = {
  boundary: "action",
  intent: ["Commit the authorized scoped change with configured hooks."],
  projectInstructions: "Preserve unrelated changes and respect hook policy.",
  subject: { toolName: "bash", input: { command: "git commit -m fixture" } },
}

for (const retired of ["off", "shadow"] as const) {
  test(`retired ${retired} configuration returns a typed error`, () => {
    const result = parseGitHookAuthorityMode(retired)
    assert.ok(Either.isLeft(result))
    assert.equal(result.left._tag, "GitHookAuthorityFlagError")
    assert.match(result.left.message, /retired/i)
  })

  test(`retired ${retired} configuration dispatches zero classifier requests`, async () => {
    const flags: GitHookAuthorityFlags = {
      registerFlag: () => {},
      getFlag: () => retired,
    }
    let calls = 0
    const decision = await registerGitHookAuthority(flags)(
      request,
      async () => {
        calls += 1
        return { verdict: "allow", reason: "fixture", source: "classifier" }
      },
    )
    assert.equal(calls, 0)
    assert.equal(decision.verdict, "block")
    assert.match(decision.reason, /retired/i)
  })
}

test("default rendering cannot select the removed provenance policy", () => {
  const rendered = buildClassifierPrompt(request).replace(/\s+/gu, " ")
  assert.ok(rendered.startsWith("GIT HOOK AUTHORITY"))
  assert.ok(
    !rendered.includes(
      "require current exact hook configuration and source evidence",
    ),
  )
  assert.ok(
    !rendered.includes("inspect all active hook configuration and sources"),
  )
  assert.ok(!rendered.includes("{{LEGACY_"))
})

test("loaded callers retain their request/callback shape but cannot restore retired policy", async () => {
  let registeredDefault: unknown
  const flags: GitHookAuthorityFlags = {
    registerFlag: (_name, options) => {
      registeredDefault = options.default
    },
    getFlag: () => registeredDefault,
  }
  const oldRequest: ClassificationRequest = Object.freeze({
    ...request,
    gitHookAuthorityMode: "off",
  })
  const decision = await registerGitHookAuthority(flags)(
    oldRequest,
    async checked => {
      assert.equal(checked.subject, oldRequest.subject)
      assert.equal(checked.gitHookAuthorityMode, "enforce")
      assert.ok(buildClassifierPrompt(checked).startsWith("GIT HOOK AUTHORITY"))
      return {
        verdict: "allow",
        reason: "compatible callback",
        source: "classifier",
      }
    },
  )
  assert.equal(decision.verdict, "allow")
  assert.equal(oldRequest.gitHookAuthorityMode, "off")
})

test("obsolete policy files are absent, rather than retained as a second canonical path", () => {
  for (const name of [
    "classifier-legacy-linked-hooks.md",
    "classifier-legacy-main-hooks.md",
  ])
    assert.equal(
      existsSync(new URL(`../../prompts/${name}`, import.meta.url)),
      false,
    )
})
