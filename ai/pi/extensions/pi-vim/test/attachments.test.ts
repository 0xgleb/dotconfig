import assert from "node:assert/strict"
import test from "node:test"
import {
  emptyEditorAttachmentState,
  expandEditorScreenshots,
  isCurrentEditorAttachment,
  pendingEditorAttachments,
  redactEditorScreenshot,
  resolveEditorAttachmentCaption,
} from "../attachments.ts"

const pendingOne = "[Image 1: describing image…]"
const pendingTwo = "[Image 2: describing image…]"

test("screenshot paths reserve a stable editor block and expand only for submission", () => {
  const path = "/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22.png"
  const first = redactEditorScreenshot(path, emptyEditorAttachmentState())
  assert.equal(first.text, `${pendingOne}\n\n`)
  assert.equal(expandEditorScreenshots(first.text, first.state), `${path}\n\n`)
  assert.deepEqual(
    pendingEditorAttachments(emptyEditorAttachmentState(), first.state),
    [{ marker: pendingOne, path }],
  )

  const second = redactEditorScreenshot(
    `${first.text}/private/var/folders/ab/cdef/T/Second\\ Screenshot.png`,
    first.state,
  )
  assert.equal(second.text, `${pendingOne}\n\n${pendingTwo}\n\n`)
  assert.equal(second.state.paths.size, 2)
})

test("async descriptions replace only their own stable marker", () => {
  const first = redactEditorScreenshot(
    "/var/folders/ab/cdef/T/one.png\n/var/folders/ab/cdef/T/two.png",
    emptyEditorAttachmentState(),
  )
  const resolvedSecond = resolveEditorAttachmentCaption(
    first.text,
    first.state,
    pendingTwo,
    "terminal showing a pending prompt",
  )
  assert.equal(
    resolvedSecond.text,
    `${pendingOne}\n\n[Image 2: terminal showing a pending prompt]\n\n`,
  )
  assert.equal(
    expandEditorScreenshots(resolvedSecond.text, resolvedSecond.state),
    "/var/folders/ab/cdef/T/one.png\n\n/var/folders/ab/cdef/T/two.png\n\n",
  )
})

test("a late caption cannot cross a submission boundary into a reused marker", () => {
  const oldAttachment = {
    marker: pendingOne,
    path: "/var/folders/ab/cdef/T/old.png",
  }
  const current = redactEditorScreenshot(
    "/var/folders/ab/cdef/T/new.png",
    emptyEditorAttachmentState(),
  )

  assert.equal(isCurrentEditorAttachment(current.state, oldAttachment), false)
  assert.equal(
    isCurrentEditorAttachment(current.state, {
      marker: pendingOne,
      path: "/var/folders/ab/cdef/T/new.png",
    }),
    true,
  )
})

test("multiple inline escaped screenshot paths keep prompt text on separate lines", () => {
  const firstPath =
    "/var/folders/_4/hash/T/TemporaryItems/a/Screenshot\\ 2026-07-22.png"
  const secondPath =
    "/var/folders/_4/hash/T/TemporaryItems/b/Screenshot\\ 2026-07-23.png"
  const redacted = redactEditorScreenshot(
    `${firstPath} bruh\n\nand here too lol ${secondPath}`,
    emptyEditorAttachmentState(),
  )

  assert.equal(
    redacted.text,
    `${pendingOne}\n\nbruh\n\nand here too lol\n\n${pendingTwo}\n\n`,
  )
  assert.equal(redacted.state.paths.size, 2)
  assert.equal(
    expandEditorScreenshots(redacted.text, redacted.state),
    `${firstPath}\n\nbruh\n\nand here too lol\n\n${secondPath}\n\n`,
  )
})

test("ordinary editor text is unchanged", () => {
  const state = emptyEditorAttachmentState()
  assert.deepEqual(redactEditorScreenshot("hello", state), {
    text: "hello",
    state,
  })
})
