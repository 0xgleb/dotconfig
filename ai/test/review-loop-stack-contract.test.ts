import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../skills/review-loop/SKILL.md", import.meta.url),
  "utf8",
)

test("loop keeps a sequential managed-main adapter and bounded pushes", () => {
  assert.equal(/\bGraphite\b|Bash\(gt:|`gt\s/.test(source), false)
  assert.ok(source.includes("sequentially, bottom to"))
  assert.ok(source.includes('case "$current_branch" in'))
  assert.ok(source.includes("gitbutler/*) tool=gitbutler"))
  assert.ok(source.includes("*) tool=none"))
  assert.ok(source.includes("use `but push <branch-name>` for each"))
  assert.ok(source.includes("Never use bare `but push`"))
  assert.ok(source.includes("If a branch is stuck, do not push"))
})

test("stack evidence separates committed identity from owned fix deltas", () => {
  assert.ok(source.includes("Stack mode overrides the generic commands below"))
  assert.ok(source.includes("never guess trunk"))
  assert.ok(
    source.includes("Only that recorded delta belongs to this fix pass"),
  )
  assert.ok(
    source.includes(
      "timing or presence in the workspace alone does not establish ownership",
    ),
  )
  assert.ok(
    source.includes(
      "combined-workspace check is not proof of isolated branch validation",
    ),
  )
  assert.ok(source.includes("for every initial, delta and escalated pass"))
  assert.ok(source.includes("Supply both artifact paths to reviewers"))
  assert.ok(source.includes("No verified default branch; resolve it"))
  assert.ok(
    source.includes("Do not execute the shell block below in stack mode"),
  )
})

const runDeltaExample = async (reviewSource: unknown) => {
  const section = source.split("**Otherwise run delta mode**")[1]
  assert.ok(section)
  const code = section.match(/```javascript\n([\s\S]*?)```/)?.[1]
  assert.ok(code)
  const run = new Function(
    "args",
    "parallel",
    "agent",
    `return (async () => { ${code.replace(/^export const meta/m, "const meta")} })()`,
  )
  const prompts: string[] = []
  const output: unknown = await run(
    {
      fixedFindings: [{ title: "scoped fix" }],
      deltaDiffPath: "owned.patch",
      fullDiffPath: "committed.patch",
      repoRoot: "/combined-workspace",
      docsPaths: [],
      reviewSource,
    },
    (tasks: Array<() => unknown>) => Promise.all(tasks.map(task => task())),
    async (prompt: string) => {
      prompts.push(prompt)
      return { fixed: true, rationale: "test", new_issues: [], findings: [] }
    },
  )
  return { output, prompts }
}

test("delta example blocks missing scope before launching reviewers", async () => {
  const result = await runDeltaExample(undefined)
  assert.deepEqual(result.output, {
    status: "blocked",
    reason: "Missing explicit review source identity",
  })
  assert.deepEqual(result.prompts, [])
})

test("both delta reviewer prompts carry committed-source and owned-overlay identity", async () => {
  const scope = {
    mode: "stack",
    branch: "feature-a",
    parentSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sourceRoot: "/review/committed-source",
    ownedDeltaPath: "owned.patch",
  }
  const result = await runDeltaExample(scope)
  assert.equal(result.prompts.length, 2)
  for (const prompt of result.prompts) {
    assert.ok(prompt.includes(JSON.stringify(scope)))
    assert.ok(prompt.includes("never the combined workspace"))
  }
})
