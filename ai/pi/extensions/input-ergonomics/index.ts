import { readFile, realpath, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isAllowedTemporaryPath,
  MAX_SCREENSHOT_BYTES,
  parseTemporaryScreenshots,
  validateImageMagic,
} from "./core.ts";

const inputErgonomics: (pi: ExtensionAPI) => void = (pi) => {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    const batch = parseTemporaryScreenshots(event.text, (event.images?.length ?? 0) + 1);
    if (!batch) return { action: "continue" };

    try {
      const images = await Promise.all(
        batch.screenshots.map(async (screenshot): Promise<ImageContent> => {
          const resolvedPath = await realpath(screenshot.path);
          if (!isAllowedTemporaryPath(resolvedPath)) {
            throw new Error("Screenshot resolves outside the macOS temporary-image area.");
          }
          const metadata = await stat(resolvedPath);
          if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SCREENSHOT_BYTES) {
            throw new Error("Screenshot must be a non-empty image no larger than 20 MiB.");
          }
          const bytes = await readFile(resolvedPath);
          if (!validateImageMagic(bytes, screenshot.mimeType)) {
            throw new Error("Screenshot contents do not match its image extension.");
          }
          return {
            type: "image",
            data: bytes.toString("base64"),
            mimeType: screenshot.mimeType,
          };
        }),
      );
      return {
        action: "transform",
        text: batch.text,
        images: [...(event.images ?? []), ...images],
      };
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Could not attach the temporary screenshot.", "error");
      return { action: "handled" };
    }
  });
};

export default inputErgonomics;
