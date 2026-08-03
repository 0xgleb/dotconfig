import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentPrompt,
  isAllowedTemporaryPath,
  MAX_SCREENSHOT_BYTES,
  parseTemporaryScreenshot,
  parseTemporaryScreenshots,
  redactTemporaryScreenshotForEditor,
  validateImageMagic,
} from "./core.ts";

test("temporary screenshot parser accepts only exact macOS temp image paths", () => {
  assert.deepEqual(
    parseTemporaryScreenshot("/var/folders/ab/cdef/T/pi-clipboard-123.png"),
    { path: "/var/folders/ab/cdef/T/pi-clipboard-123.png", mimeType: "image/png", remainingText: "" },
  );
  assert.deepEqual(
    parseTemporaryScreenshot("/private/var/folders/ab/cdef/T/pi-hover-panel.png"),
    { path: "/private/var/folders/ab/cdef/T/pi-hover-panel.png", mimeType: "image/png", remainingText: "" },
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
  assert.deepEqual(
    parseTemporaryScreenshot(
      "before /var/folders/_4/hash/T/TemporaryItems/capture/Screenshot\\ 2026-07-22\\ at\\ 15.44.18.png after reload",
    ),
    {
      path: "/var/folders/_4/hash/T/TemporaryItems/capture/Screenshot 2026-07-22 at 15.44.18.png",
      mimeType: "image/png",
      remainingText: "before after reload",
    },
  );
  assert.equal(MAX_SCREENSHOT_BYTES, 20 * 1024 * 1024);
});

test("editor redaction replaces only the temporary path with a clean marker", () => {
  assert.deepEqual(
    redactTemporaryScreenshotForEditor(
      "compare this\n/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22.png",
      "[Image 1]",
    ),
    {
      displayText: "compare this\n[Image 1]",
      pathText: "/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22.png",
    },
  );
  assert.deepEqual(
    redactTemporaryScreenshotForEditor(
      "before /private/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22.png after",
      "[Image 2]",
    ),
    {
      displayText: "before [Image 2] after",
      pathText: "/private/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22.png",
    },
  );
});

test("screenshot batches preserve compact markers and surrounding text", () => {
  const first = "/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22\\ at\\ 19.43.12.png";
  const second = "/var/folders/ab/cdef/T/Screenshot\\ 2026-07-22\\ at\\ 19.43.24.png";
  assert.deepEqual(
    parseTemporaryScreenshots(`${first} bruh\n\nand here too lol ${second}`, 2),
    {
      screenshots: [
        { path: "/var/folders/ab/cdef/T/Screenshot 2026-07-22 at 19.43.12.png", mimeType: "image/png" },
        { path: "/var/folders/ab/cdef/T/Screenshot 2026-07-22 at 19.43.24.png", mimeType: "image/png" },
      ],
      text: "[Image 2] bruh\n\nand here too lol [Image 3]",
    },
  );
});

test("temporary path allowlist rejects traversal and unrelated roots", () => {
  assert.equal(isAllowedTemporaryPath("/var/folders/ab/cdef/T/image.png"), true);
  assert.equal(isAllowedTemporaryPath("/var/folders/ab/cdef/TemporaryItems/image.png"), true);
  assert.equal(isAllowedTemporaryPath("/private/var/folders/ab/cdef/T/image.png"), true);
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

test("attachment prompt keeps an image marker in the sent message without disclosing the path", () => {
  assert.equal(attachmentPrompt(""), "[Image 1]");
  assert.equal(attachmentPrompt("compare the spacing"), "compare the spacing\n\n[Image 1]");
  assert.equal(attachmentPrompt("compare two", 2), "compare two\n\n[Image 2]");
});
