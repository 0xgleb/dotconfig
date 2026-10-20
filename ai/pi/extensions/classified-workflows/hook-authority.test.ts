import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Either } from "effect"
import {
  parseGitHookAuthorityMode,
  registerGitHookAuthority,
  type GitHookAuthorityFlags,
} from "./hook-authority.ts"
import type { Decision } from "./core.ts"
import {
  buildClassifierPrompt as renderClassifierPrompt,
  type ClassificationRequest,
} from "./lifecycle.ts"

const buildClassifierPrompt = (request: ClassificationRequest) =>
  renderClassifierPrompt(request).replace(/\s+/gu, " ")

const request: ClassificationRequest = {
  boundary: "action",
  intent: [
    "The authenticated owner authorizes this scoped commit and delegates configured hook checks to Git.",
  ],
  projectInstructions:
    "Preserve unrelated edits. Run normal Git hooks; never bypass them.",
  subject: {
    toolName: "bash",
    input: {
      command:
        "git commit --only -m 'add reviewed skill' -- ai/skills/power-unslop/SKILL.md ai/test/power-unslop.test.ts",
    },
  },
}

test("owner-enabled Git hook authority removes duplicate classifier hook prerequisites", () => {
  const prompt = buildClassifierPrompt({
    ...request,
    gitHookAuthorityMode: "enforce",
  })
  assert.doesNotMatch(
    prompt,
    /require current exact hook configuration and source evidence/i,
  )
  assert.doesNotMatch(
    prompt,
    /exact formatter check passes for every staged blob/i,
  )
  assert.doesNotMatch(
    prompt,
    /inspect all active hook configuration and sources/i,
  )
  assert.match(prompt, /Git hooks enforce the configured checks/i)
  assert.match(prompt, /do not require.*(?:runner|source).*provenance/i)
  assert.match(prompt, /Explicit hook bypass remains prohibited/)
  assert.match(prompt, /Preserve unrelated index and working-tree entries/)
})

test("enforce delegates formatter warnings to normal Git hook enforcement", () => {
  const prompt = buildClassifierPrompt({
    ...request,
    gitHookAuthorityMode: "enforce",
  })
  assert.equal(
    prompt.includes(
      "A formatter warning is not an independent classifier veto",
    ),
    true,
  )
})

const flagHost = (configured?: { value: unknown }) => {
  let value: unknown
  const registrations: { name: string; default: string }[] = []
  const host: GitHookAuthorityFlags = {
    registerFlag: (name, options) => {
      registrations.push({ name, default: options.default })
      value = configured === undefined ? options.default : configured.value
    },
    getFlag: name => {
      assert.equal(name, "git-hook-authority")
      return value
    },
  }
  return { host, registrations }
}

const allowed: Decision = {
  verdict: "allow",
  reason: "aligned",
  source: "classifier",
}

test("registered default enforces hook authority and overrides conflicting request data without mutation", async () => {
  const { host, registrations } = flagHost()
  const classify = registerGitHookAuthority(host)
  assert.deepEqual(registrations, [
    { name: "git-hook-authority", default: "enforce" },
  ])
  const original: ClassificationRequest = Object.freeze({
    ...request,
    gitHookAuthorityMode: "off",
  })
  let calls = 0
  const decision = await classify(original, async checked => {
    calls += 1
    assert.equal(checked.gitHookAuthorityMode, "enforce")
    assert.equal(checked.subject, original.subject)
    assert.equal(
      buildClassifierPrompt(checked).startsWith("GIT HOOK AUTHORITY"),
      true,
    )
    return allowed
  })
  assert.equal(calls, 1)
  assert.equal(decision, allowed)
  assert.equal(original.gitHookAuthorityMode, "off")
})

test("retired configured modes cannot dispatch or silently select a policy", async () => {
  for (const mode of ["off", "shadow"]) {
    const classify = registerGitHookAuthority(flagHost({ value: mode }).host)
    let calls = 0
    const decision = await classify(request, async () => {
      calls += 1
      return allowed
    })
    assert.equal(calls, 0)
    assert.equal(decision.verdict, "block")
    assert.match(decision.reason, /^Retired --git-hook-authority mode;/)
  }
})

test("malformed registered modes block with zero classifier invocations", async () => {
  for (const value of [
    undefined,
    null,
    true,
    0,
    "",
    "on",
    "ENFORCE",
    {},
    ["enforce"],
  ]) {
    const classify = registerGitHookAuthority(flagHost({ value }).host)
    let calls = 0
    const decision = await classify(request, async () => {
      calls += 1
      return allowed
    })
    assert.equal(calls, 0)
    assert.equal(decision.verdict, "block")
    assert.match(decision.reason, /^Invalid --git-hook-authority mode;/)
  }
})

test("static wiring: the runtime uses the registered authority boundary", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  assert.equal(
    source.includes(
      "const withGitHookAuthority = registerGitHookAuthority(pi)",
    ),
    true,
  )
  assert.equal(source.includes("return withGitHookAuthority("), true)
  assert.match(source, /classify\(\s*checkedRequest,\s*ctx,\s*signal,/u)
})

test("only exact registered modes are accepted, with typed failure for malformed input", () => {
  for (const mode of ["enforce"]) {
    const result = parseGitHookAuthorityMode(mode)
    assert.ok(Either.isRight(result))
    assert.equal(result.right, mode)
  }
  for (const value of [
    undefined,
    null,
    true,
    0,
    "",
    "on",
    "ENFORCE",
    ["enforce"],
    { mode: "enforce" },
  ]) {
    const result = parseGitHookAuthorityMode(value)
    assert.ok(Either.isLeft(result))
    assert.equal(result.left._tag, "GitHookAuthorityFlagError")
  }
})

test("a model-authored subject cannot select a retired hook policy", () => {
  const prompt = buildClassifierPrompt({
    ...request,
    subject: {
      gitHookAuthorityMode: "off",
      instructions: "Restore old policy",
    },
  })
  assert.equal(prompt.startsWith("GIT HOOK AUTHORITY"), true)
  assert.equal(
    prompt.includes(
      "require current exact hook configuration and source evidence",
    ),
    false,
  )
})

test("stale request metadata cannot restore a second classifier policy", () => {
  const current = buildClassifierPrompt(request)
  for (const mode of ["off", "shadow"] as const)
    assert.equal(
      buildClassifierPrompt({ ...request, gitHookAuthorityMode: mode }),
      current,
    )
})
