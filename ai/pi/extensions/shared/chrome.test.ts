import assert from "node:assert/strict"
import test from "node:test"
import { visibleWidth } from "@earendil-works/pi-tui"

import {
  alignChromeLine,
  chromeInset,
  framedChromeInset,
} from "./chrome.ts"

test("shared Pi chrome compensates framed surfaces for the host's built-in padding", () => {
  for (const width of [40, 80, 180]) {
    assert.equal(framedChromeInset(width) + 1, chromeInset(width))
  }
})

test("shared Pi chrome uses one symmetric pane-relative gutter", () => {
  for (const width of [4, 40, 80, 180]) {
    const inset = chromeInset(width)
    const line = alignChromeLine("READY · awaiting activity", width)
    assert.equal(visibleWidth(line), width)
    assert.equal(line.search(/\S/u), inset)
    assert.equal(line.endsWith(" ".repeat(inset)), true)
  }
})
