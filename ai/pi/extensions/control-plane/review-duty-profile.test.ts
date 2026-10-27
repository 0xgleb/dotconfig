import assert from "node:assert/strict"
import test from "node:test"

import { automaticRepositoryForProfile } from "./review-duty-profile.ts"

test("automatic review targets remain bound to their permitted profile", () => {
  assert.equal(
    automaticRepositoryForProfile("dataclique-review"),
    "dataclique/yielduck",
  )
  assert.equal(
    automaticRepositoryForProfile("personal-review"),
    "0xgleb/dotconfig",
  )
  assert.equal(automaticRepositoryForProfile("st0x-review"), undefined)
})
