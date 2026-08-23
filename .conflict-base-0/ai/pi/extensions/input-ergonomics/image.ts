import { readFile, realpath, stat } from "node:fs/promises"
import type { ImageContent } from "@earendil-works/pi-ai"

import {
  isAllowedTemporaryPath,
  MAX_SCREENSHOT_BYTES,
  type TemporaryScreenshot,
  validateImageMagic,
} from "./core.ts"

export class TemporaryImageError extends Error {
  override readonly name = "TemporaryImageError"
}

export const loadTemporaryImage = async (
  screenshot: Omit<TemporaryScreenshot, "remainingText">,
): Promise<ImageContent> => {
  const resolvedPath = await realpath(screenshot.path)
  if (!isAllowedTemporaryPath(resolvedPath))
    throw new TemporaryImageError(
      "Screenshot resolves outside the macOS temporary-image area.",
    )
  const metadata = await stat(resolvedPath)
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_SCREENSHOT_BYTES
  )
    throw new TemporaryImageError(
      "Screenshot must be a non-empty image no larger than 20 MiB.",
    )
  const bytes = await readFile(resolvedPath)
  if (!validateImageMagic(bytes, screenshot.mimeType))
    throw new TemporaryImageError(
      "Screenshot contents do not match its image extension.",
    )
  return {
    type: "image",
    data: bytes.toString("base64"),
    mimeType: screenshot.mimeType,
  }
}
