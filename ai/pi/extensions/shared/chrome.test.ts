import assert from "node:assert/strict"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"

import { alignChromeLine, chromeInset } from "./chrome.ts"

test("shared Pi chrome uses one symmetric pane-relative gutter", () => {
  for (const width of [4, 40, 80, 180]) {
    const inset = chromeInset(width)
    const line = alignChromeLine("READY · awaiting activity", width)
    assert.equal(visibleWidth(line), width)
    assert.equal(line.search(/\S/u), inset)
    assert.equal(line.endsWith(" ".repeat(inset)), true)
  }
})
