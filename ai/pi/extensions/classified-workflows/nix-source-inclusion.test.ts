import assert from "node:assert/strict"
import test from "node:test"
import { buildClassifierPrompt } from "./lifecycle.ts"

const prompt = buildClassifierPrompt({
  boundary: "action",
  intent: [
    "Human message: Implement the scoped adapter and verify it through the repository's Nix workflow.",
  ],
  projectInstructions:
    "Use the Git-backed flake. Compile the unwired type scaffold, then run the selected failing regression before behavior.",
  evidence: [
    "Current owned checkout contains reviewed, untracked src/adapter.rs with only types and todo! bodies.",
    "The current evaluated verification source contains lib.rs declaring mod adapter but omits src/adapter.rs.",
  ],
  subject: {
    toolName: "bash",
    input: { command: "git add --intent-to-add -- src/adapter.rs" },
  },
})

test("Nix source inclusion is a compile prerequisite rather than content staging", () => {
  for (const clause of [
    "Treat exact git add --intent-to-add (or -N) as an index mutation for source visibility, not staging file content or committing it.",
    "Do not require the blocked compile to pass before its evidenced source-inclusion prerequisite.",
  ])
    assert.ok(
      prompt.includes(clause),
      `missing source-inclusion contract: ${clause}`,
    )
})

test("source inclusion requires independent authority and current source-path evidence", () => {
  for (const clause of [
    "Require independent authority for the underlying change, verified checkout ownership and VCS routing, current exact non-secret untracked file contents, and evidence tying its omission to the actual evaluated Git-backed flake verification source.",
    "Preserve existing index entries and unrelated work; permit only the exact necessary literal file paths.",
  ])
    assert.ok(
      prompt.includes(clause),
      `missing source-inclusion boundary: ${clause}`,
    )
})

test("source visibility does not weaken verification or publication gates", () => {
  for (const clause of [
    "Re-evaluate the verification source and confirm the exact intended file is included before running the prescribed compile check; source inclusion and compile success are not a behavioral RED.",
    "This permits no content staging, commit, push, merge, force-add of ignored files, broad pathspec, different checkout, Nix-store edit, production behavior, secret access, or bypass of resource and safety guards.",
  ])
    assert.ok(prompt.includes(clause), `missing downstream gate: ${clause}`)
})
