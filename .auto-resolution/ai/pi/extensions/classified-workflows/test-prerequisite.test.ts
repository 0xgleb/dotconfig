import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { additiveTestEditDisprovesMissingTestBlock } from "./test-prerequisite.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const call = (id: string, name: string, args: unknown) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
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

const verifiedPrerequisites = [
  call("show-regression", "bash", {
    command: "git show eb7bd687 -- crates/yielduck/tests/allocation.rs",
  }),
  result(
    "show-regression",
    "commit eb7bd687\n+async fn a_hung_nav_read_defers_before_the_durable_worker_timeout()",
  ),
  call("read-spec", "read", { path: "SPEC.md" }),
  result(
    "read-spec",
    "The NavChart keeps the last durable NAV visible while a fresh read is deferred.",
  ),
  call("read-e2e", "read", { path: "frontend/e2e/nav-chart.spec.ts" }),
  result(
    "read-e2e",
    "test('NavChart preserves the prior NAV while the backend read is deferred', async () => {})",
  ),
]

const navChartTestEdit = {
  path: "frontend/src/components/NavChart.test.tsx",
  edits: [
    {
      oldText: "describe('NavChart', () => {\n",
      newText:
        "describe('NavChart', () => {\n  it('keeps the prior NAV while a read is deferred', () => {})\n",
    },
  ],
}

test("verified backend, spec, and e2e evidence permits the additive component test", () => {
  assert.equal(
    additiveTestEditDisprovesMissingTestBlock({
      reason:
        "A failing service e2e is required before adding this NavChart component regression test.",
      edit: navChartTestEdit,
      branch: verifiedPrerequisites,
    }),
    true,
  )
  assert.match(
    extensionSource,
    /event\.toolName === "edit"[\s\S]*?additiveTestEditDisprovesMissingTestBlock/,
  )
})

test("the override requires every prerequisite and cannot weaken tests or implementation gates", () => {
  const cases = [
    {
      reason: "Removing this assertion would weaken the test.",
      edit: navChartTestEdit,
      branch: verifiedPrerequisites,
    },
    {
      reason: "A failing e2e is required before implementation.",
      edit: {
        ...navChartTestEdit,
        path: "frontend/src/components/NavChart.tsx",
      },
      branch: verifiedPrerequisites,
    },
    {
      reason: "A failing e2e is required first.",
      edit: {
        ...navChartTestEdit,
        edits: [
          {
            oldText: "expect(nav).toBe(old)",
            newText: "expect(nav).toBe(new)",
          },
        ],
      },
      branch: verifiedPrerequisites,
    },
    {
      reason: "This unrelated test edit is unauthorized.",
      edit: navChartTestEdit,
      branch: verifiedPrerequisites,
    },
    {
      reason: "A failing service e2e is required before this component test.",
      edit: navChartTestEdit,
      branch: [
        ...verifiedPrerequisites.slice(0, 2),
        ...verifiedPrerequisites.slice(4),
      ],
    },
    {
      reason: "A failing service e2e is required before this component test.",
      edit: navChartTestEdit,
      branch: [
        call("show-regression", "bash", {
          command: "git show abc12345 -- crates/yielduck/tests/orders.rs",
        }),
        result("show-regression", "+fn an_unrelated_order_test()"),
        ...verifiedPrerequisites.slice(2),
      ],
    },
  ]
  for (const candidate of cases) {
    assert.equal(additiveTestEditDisprovesMissingTestBlock(candidate), false)
  }
})
