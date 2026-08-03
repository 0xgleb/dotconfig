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

test("multiple screenshot paths pasted together become independent attachments", () => {
  const firstPath =
    "/var/folders/_4/rw1_bp053k5cl_mv2jg2854w0000gn/T/TemporaryItems/NSIRD_screencaptureui_qRKFSF/Screenshot 2026-07-22 at 19.21.54.png";
  const secondPath =
    "/var/folders/_4/rw1_bp053k5cl_mv2jg2854w0000gn/T/TemporaryItems/NSIRD_screencaptureui_WMzzgp/Screenshot 2026-07-22 at 19.22.07.png";
  const redacted = redactEditorScreenshot(`${firstPath}\n${secondPath}`, emptyEditorAttachmentState());

  assert.equal(redacted.text, "[Image 1]\n[Image 2]");
  assert.equal(redacted.state.paths.size, 2);
  assert.equal(expandEditorScreenshots(redacted.text, redacted.state), `${firstPath}\n${secondPath}`);
});

test("multiple inline escaped screenshot paths preserve surrounding prompt text", () => {
  const firstPath =
    "/var/folders/_4/rw1_bp053k5cl_mv2jg2854w0000gn/T/TemporaryItems/NSIRD_screencaptureui_gmlueX/Screenshot\\ 2026-07-22\\ at\\ 19.43.12.png";
  const secondPath =
    "/var/folders/_4/rw1_bp053k5cl_mv2jg2854w0000gn/T/TemporaryItems/NSIRD_screencaptureui_Pidjp7/Screenshot\\ 2026-07-22\\ at\\ 19.43.24.png";
  const redacted = redactEditorScreenshot(
    `${firstPath} bruh\n\nand here too lol ${secondPath}`,
    emptyEditorAttachmentState(),
  );

  assert.equal(redacted.text, "[Image 1] bruh\n\nand here too lol [Image 2]");
  assert.equal(redacted.state.paths.size, 2);
  assert.equal(
    expandEditorScreenshots(redacted.text, redacted.state),
    `${firstPath} bruh\n\nand here too lol ${secondPath}`,
  );
});

test("ordinary editor text is unchanged", () => {
  const state = emptyEditorAttachmentState();
  assert.deepEqual(redactEditorScreenshot("hello", state), { text: "hello", state });
});
