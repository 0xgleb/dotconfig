import assert from "node:assert/strict"
import test from "node:test"
import { initTheme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { verdictView } from "./verdict-view.ts"

test("verdicts render Markdown and wrap prose within narrow and wide panes", () => {
  initTheme("dark")
  for (const width of [42, 140]) {
    const rows = verdictView(
      "▲",
      `**Blocked** ${"verification needed ".repeat(10)}`,
    ).render(width)
    assert.match(rows[0] ?? "", /▲/)
    assert.ok(rows.every(row => visibleWidth(row) <= width))
    if (width > 80) assert.ok(rows.some(row => visibleWidth(row) > 80))
    assert.ok(!rows.join("\n").includes("**Blocked**"))
  }
})
