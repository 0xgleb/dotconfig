import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyEditorAttachmentState,
  expandEditorScreenshots,
  redactEditorScreenshot,
} from "../attachments.ts";

test("screenshot paths render as markers and expand only for submission", () => {
  const first = redactEditorScreenshot(
    "/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22.png",
    emptyEditorAttachmentState(),
  );
  assert.equal(first.text, "[Image 1]");
  assert.equal(
    expandEditorScreenshots(`inspect ${first.text}`, first.state),
    "inspect /var/folders/ab/cdef/T/Screenshot\\ 2026-07-22.png",
  );

  const second = redactEditorScreenshot(
    `${first.text}\n/private/var/folders/ab/cdef/T/Second\\ Screenshot.png`,
    first.state,
  );
  assert.equal(second.text, "[Image 1]\n[Image 2]");
  assert.equal(second.state.paths.size, 2);
});

test("ordinary editor text is unchanged", () => {
  const state = emptyEditorAttachmentState();
  assert.deepEqual(redactEditorScreenshot("hello", state), { text: "hello", state });
});
