import { readFile, realpath, stat } from "node:fs/promises"
import type { ImageContent } from "@earendil-works/pi-ai"
import { Data, Effect } from "effect"

import {
  isAllowedTemporaryPath,
  MAX_SCREENSHOT_BYTES,
  type TemporaryScreenshot,
  validateImageMagic,
} from "./core.ts"

export class TemporaryImageError extends Data.TaggedError(
  "TemporaryImageError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const loadTemporaryImage = async (
  screenshot: Omit<TemporaryScreenshot, "remainingText">,
): Promise<ImageContent> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resolvedPath = yield* Effect.tryPromise({
        try: () => realpath(screenshot.path),
        catch: cause =>
          new TemporaryImageError({
            message: "Could not resolve the temporary screenshot path.",
            cause,
          }),
      })
      if (!isAllowedTemporaryPath(resolvedPath))
        return yield* Effect.fail(
          new TemporaryImageError({
            message:
              "Screenshot resolves outside the macOS temporary-image area.",
          }),
        )
      const metadata = yield* Effect.tryPromise({
        try: () => stat(resolvedPath),
        catch: cause =>
          new TemporaryImageError({
            message: "Could not inspect the temporary screenshot.",
            cause,
          }),
      })
      if (
        !metadata.isFile() ||
        metadata.size < 1 ||
        metadata.size > MAX_SCREENSHOT_BYTES
      )
        return yield* Effect.fail(
          new TemporaryImageError({
            message:
              "Screenshot must be a non-empty image no larger than 20 MiB.",
          }),
        )
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(resolvedPath),
        catch: cause =>
          new TemporaryImageError({
            message: "Could not read the temporary screenshot.",
            cause,
          }),
      })
      if (!validateImageMagic(bytes, screenshot.mimeType))
        return yield* Effect.fail(
          new TemporaryImageError({
            message: "Screenshot contents do not match its image extension.",
          }),
        )
      return {
        type: "image" as const,
        data: bytes.toString("base64"),
        mimeType: screenshot.mimeType,
      }
    }),
  )
