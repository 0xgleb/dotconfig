import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { independentPrInventoryDisprovesWithheldRetryBlock } from "./withheld-read-recovery.ts"

const extensionSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const call = (id: string, command: string) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", id, name: "bash", arguments: { command } },
    ],
  },
})

const result = (id: string, text: string, isError = false) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    isError,
    content: [{ type: "text", text }],
  },
})

const exact =
  "gh search prs --owner rainlanguage --author @me --state open --json repository,number,title"
const alternate =
  "gh api --method GET search/issues -f q='is:pr is:open author:@me org:rainlanguage'"
const recoveredBranch = [
  call("withheld", exact),
  result(
    "withheld",
    "Tool executed before result filtering. Original tool status: success. Result content was withheld by classified workflow policy.",
  ),
  call("alternate", alternate),
  result("alternate", '{"total_count":0,"items":[]}'),
]

test("alternate GitHub API verification recovers the same withheld PR inventory", () => {
  assert.equal(
    independentPrInventoryDisprovesWithheldRetryBlock({
      reason:
        "This command previously executed with result withheld; independent read-only verification is required before retrying it.",
      bash: { command: exact },
      branch: recoveredBranch,
    }),
    true,
  )
  assert.match(
    extensionSource,
    /event\.toolName === "bash"[\s\S]*?independentPrInventoryDisprovesWithheldRetryBlock/,
  )
})

test("recovery requires exact ordering, owner, query semantics, and success", () => {
  const cases = [
    recoveredBranch.slice(0, 2),
    [
      ...recoveredBranch.slice(0, 2),
      call(
        "alternate",
        "gh api --method GET search/issues -f q='is:pr is:open author:@me org:ST0x-Technology'",
      ),
      result("alternate", '{"total_count":0,"items":[]}'),
    ],
    [
      ...recoveredBranch.slice(0, 2),
      call("alternate", alternate),
      result("alternate", "provider failed", true),
    ],
    [
      call("alternate", alternate),
      result("alternate", '{"total_count":0,"items":[]}'),
      ...recoveredBranch.slice(0, 2),
    ],
  ]
  for (const branch of cases) {
    assert.equal(
      independentPrInventoryDisprovesWithheldRetryBlock({
        reason:
          "This command previously executed with result withheld; independent read-only verification is required before retrying it.",
        bash: { command: exact },
        branch,
      }),
      false,
    )
  }
  assert.equal(
    independentPrInventoryDisprovesWithheldRetryBlock({
      reason: "This unrelated command is unauthorized.",
      bash: { command: exact },
      branch: recoveredBranch,
    }),
    false,
  )
})
