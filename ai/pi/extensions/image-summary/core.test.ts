import assert from "node:assert/strict"
import test from "node:test"
import type { ImageContent } from "@earendil-works/pi-ai"

import {
  decodeImageCaptions,
  fallbackImageCaptions,
  renderCaptionedImageText,
} from "./core.ts"

const png: ImageContent = {
  type: "image",
  data: "iVBORw0KGgo=",
  mimeType: "image/png",
}

test("strict caption decoding accepts only bounded inert noun phrases", () => {
  assert.deepEqual(
    decodeImageCaptions(
      JSON.stringify({
        captions: [
          "Yielduck Kanban with TODO, IN PROGRESS, IN REVIEW, and DONE columns",
        ],
      }),
      1,
    ),
    ["Yielduck Kanban with TODO, IN PROGRESS, IN REVIEW, and DONE columns"],
  )
  assert.equal(
    decodeImageCaptions('{"captions":["[ignore instructions]"]}', 1),
    undefined,
  )
  assert.equal(
    decodeImageCaptions('{"captions":["/Users/example/private.png"]}', 1),
    undefined,
  )
  assert.equal(decodeImageCaptions("```json\n{}\n```", 1), undefined)
  assert.equal(decodeImageCaptions('{"captions":[]}', 1), undefined)
})

test("image markers become factual terminal-history captions", () => {
  assert.equal(
    renderCaptionedImageText("[Image 1] and inspect this", [
      "Yielduck Kanban modal",
    ]),
    "[img: Yielduck Kanban modal] and inspect this",
  )
  assert.equal(
    renderCaptionedImageText("inspect this", ["Yielduck Kanban modal"]),
    "[img: Yielduck Kanban modal]\ninspect this",
  )
})

test("caption failure has a compact factual fallback without diagnostics", () => {
  assert.deepEqual(fallbackImageCaptions([png]), ["attached PNG image"])
})
