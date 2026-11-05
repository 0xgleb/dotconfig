import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Effect, Either } from "effect"
import { createGitHubCliProjectReader } from "./github-cli.ts"
import { decodeGitHubProjectQuery } from "./github-project-read.ts"

// Source-owned, non-secret boolean opt-in for read-only GitHub I/O.
const enabled = process.env.PI_ISSUE_TASK_GITHUB_LIVE_READ_TESTS === "1"

test(
  "native Project adapter reads both selected scheduling contracts without content output",
  { skip: !enabled, timeout: 45_000 },
  async t => {
    const reader = createGitHubCliProjectReader({
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    })

    for (const project of ["personal", "dataclique"] as const) {
      const page = await Effect.runPromise(
        reader.read({ project, page: { limit: 1 } }),
        { signal: t.signal },
      )

      assert.equal(page.project, project)
      assert.ok(page.items.length <= 1)
      assert.equal(typeof page.pageInfo.hasNextPage, "boolean")
      if (page.pageInfo.hasNextPage) {
        assert.ok(typeof page.pageInfo.endCursor === "string")
        assert.ok(
          Either.isRight(
            decodeGitHubProjectQuery({
              project,
              page: { limit: 1, after: page.pageInfo.endCursor },
            }),
          ),
        )
      }
    }
  },
)
