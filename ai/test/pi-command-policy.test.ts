import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { buildClassifierPrompt } from "../pi/extensions/classified-workflows/lifecycle.ts"

const prompt = buildClassifierPrompt({
  boundary: "action",
  intent: [
    "Publish only the verified cleanup to master and preserve unrelated edits.",
  ],
  projectInstructions:
    "Use native Nushell. Commit and push authorized changes to master.",
  subject: {
    toolName: "bash",
    input: { command: 'git commit --only -m "cleanup" -- owned.json' },
  },
})
const source = (file: string): string =>
  readFileSync(
    new URL(`../pi/extensions/classified-workflows/${file}`, import.meta.url),
    "utf8",
  )

test("Git command grammar is not a deterministic admission gate", () => {
  assert.equal(
    /unsafeRuntimeCommandLocationBlockReason|commandLocationBlock/.test(
      source("index.ts"),
    ),
    false,
  )
  assert.equal(
    /Git commands require either the session cwd/.test(
      source("project-context.ts"),
    ),
    false,
  )
})

test("the classifier does not impose command-shape prohibitions", () => {
  assert.equal(
    /Do not use commit --only|Allow only an exact plain `git commit`/.test(
      prompt,
    ),
    false,
  )
  assert.equal(
    /exactly one bounded leading cd line.*exactly one following command line/.test(
      prompt,
    ),
    false,
  )
  assert.equal(
    /Dynamic, parameter-expanded, relative, globbed, tilde, escaped, redirected, shell-composed, multi-line/.test(
      prompt,
    ),
    false,
  )
})

test("removing grammar gates preserves authority, secret and hook boundaries", () => {
  assert.match(
    prompt,
    /A mutation must be explicitly requested or necessary to complete active intent/,
  )
  assert.match(
    prompt,
    /access to credential, secret-bearing, encrypted-secret, private-key/,
  )
  assert.match(prompt, /Preserve unrelated unstaged changes/)
  assert.match(source("index.ts"), /gitEnvironmentOverrideBlockReason/)
})
