import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentPrompt,
  isAllowedTemporaryPath,
  MAX_SCREENSHOT_BYTES,
  parseTemporaryScreenshot,
  validateImageMagic,
} from "./core.ts";

test("temporary screenshot parser accepts only exact macOS temp image paths", () => {
  assert.deepEqual(
    parseTemporaryScreenshot("/var/folders/ab/cdef/T/pi-clipboard-123.png"),
    { path: "/var/folders/ab/cdef/T/pi-clipboard-123.png", mimeType: "image/png", remainingText: "" },
  );
  assert.deepEqual(
    parseTemporaryScreenshot("'/var/folders/ab/cdef/TemporaryItems/Screenshot 2026-07-21 at 23.47.22.png'"),
    {
      path: "/var/folders/ab/cdef/TemporaryItems/Screenshot 2026-07-21 at 23.47.22.png",
      mimeType: "image/png",
      remainingText: "",
    },
  );
  for (const input of [
    "/Users/example/Desktop/private.png",
    "/var/folders/ab/cdef/T/not-an-image.txt",
    "/var/folders/ab/cdef/T/../secrets.png",
    "please inspect /var/folders/ab/cdef/T/image.png and do something else",
  ]) {
    assert.equal(parseTemporaryScreenshot(input), undefined);
  }
  assert.deepEqual(
    parseTemporaryScreenshot(
      "compare the allocation panel\n/var/folders/ab/cdef/TemporaryItems/Screenshot\\ 2026-07-22\\ at\\ 14.23.30.png",
    ),
    {
      path: "/var/folders/ab/cdef/TemporaryItems/Screenshot 2026-07-22 at 14.23.30.png",
      mimeType: "image/png",
      remainingText: "compare the allocation panel",
    },
  );
  assert.equal(MAX_SCREENSHOT_BYTES, 20 * 1024 * 1024);
});

test("temporary path allowlist rejects traversal and unrelated roots", () => {
  assert.equal(isAllowedTemporaryPath("/var/folders/ab/cdef/T/image.png"), true);
  assert.equal(isAllowedTemporaryPath("/var/folders/ab/cdef/TemporaryItems/image.png"), true);
  assert.equal(isAllowedTemporaryPath("/tmp/image.png"), false);
  assert.equal(isAllowedTemporaryPath("/var/folders/ab/cdef/T/../image.png"), false);
});

test("image magic must match the declared extension", () => {
  assert.equal(validateImageMagic(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
  assert.equal(validateImageMagic(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]), "image/jpeg"), true);
  assert.equal(validateImageMagic(new TextEncoder().encode("GIF89a"), "image/gif"), true);
  assert.equal(validateImageMagic(new TextEncoder().encode("RIFF1234WEBP"), "image/webp"), true);
  assert.equal(validateImageMagic(new TextEncoder().encode("not an image"), "image/png"), false);
});

test("attachment prompt does not disclose the temporary path", () => {
  assert.equal(attachmentPrompt(""), "Inspect the attached screenshot.");
  assert.equal(attachmentPrompt("compare the spacing"), "compare the spacing");
});
