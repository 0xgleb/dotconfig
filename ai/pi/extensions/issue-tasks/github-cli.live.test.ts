import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { createGitHubCliReader } from "./github-cli.ts"

// Source-owned, non-secret boolean opt-in: this test performs read-only GitHub I/O.
const enabled = process.env.PI_ISSUE_TASK_GITHUB_LIVE_READ_TESTS === "1"

test(
  "native GitHub CLI default adapter reads verified list/get targets",
  { skip: !enabled, timeout: 45_000 },
  async t => {
    const reader = createGitHubCliReader({
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    })
    const page = await Effect.runPromise(
      reader.list({
        repository: "0xgleb/dotconfig",
        state: "all",
        page: { limit: 1 },
      }),
      { signal: t.signal },
    )

    assert.equal(page.repository, "0xgleb/dotconfig")
    assert.equal(page.issues.length <= 1, true)
    assert.equal(
      page.issues.every(row => row.issue.repository === "0xgleb/dotconfig"),
      true,
    )

    const issue = await Effect.runPromise(
      reader.get({
        issue: { repository: "0xgleb/dotconfig", number: 86 },
        related: { limit: 1 },
      }),
      { signal: t.signal },
    )

    assert.equal(issue.issue.repository, "0xgleb/dotconfig")
    assert.equal(issue.issue.number, 86)
    assert.equal(issue.detail !== null, true)
    assert.equal(typeof issue.detail?.body, "string")
    assert.equal(issue.detail?.issue.number, 86)
  },
)
