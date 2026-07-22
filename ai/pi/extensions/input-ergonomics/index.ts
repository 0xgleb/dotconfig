import { readFile, realpath, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  attachmentPrompt,
  isAllowedTemporaryPath,
  MAX_SCREENSHOT_BYTES,
  parseTemporaryScreenshot,
  validateImageMagic,
} from "./core.ts";

const inputErgonomics: (pi: ExtensionAPI) => void = (pi) => {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    const screenshot = parseTemporaryScreenshot(event.text);
    if (!screenshot) return { action: "continue" };

    try {
      const resolvedPath = await realpath(screenshot.path);
      if (!isAllowedTemporaryPath(resolvedPath)) throw new Error("Screenshot resolves outside the macOS temporary-image area.");
      const metadata = await stat(resolvedPath);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SCREENSHOT_BYTES) {
        throw new Error("Screenshot must be a non-empty image no larger than 20 MiB.");
      }
      const bytes = await readFile(resolvedPath);
      if (!validateImageMagic(bytes, screenshot.mimeType)) {
        throw new Error("Screenshot contents do not match its image extension.");
      }

      const image: ImageContent = {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: screenshot.mimeType,
      };
      ctx.ui.notify("Attached temporary screenshot without exposing its filesystem path.", "info");
      return {
        action: "transform",
        text: attachmentPrompt(screenshot.remainingText),
        images: [...(event.images ?? []), image],
      };
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not attach the temporary screenshot.", "error");
      return { action: "handled" };
    }
  });
};

export default inputErgonomics;
