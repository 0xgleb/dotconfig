import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { parseTemporaryScreenshots } from "./core.ts"
import { loadTemporaryImage } from "./image.ts"

const inputErgonomics: (pi: ExtensionAPI) => void = pi => {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" }
    const batch = parseTemporaryScreenshots(
      event.text,
      (event.images?.length ?? 0) + 1,
    )
    if (!batch) return { action: "continue" }

    try {
      const images = await Promise.all(
        batch.screenshots.map(loadTemporaryImage),
      )
      return {
        action: "transform",
        text: batch.text,
        images: [...(event.images ?? []), ...images],
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error
          ? error.message
          : "Could not attach the temporary screenshot.",
        "error",
      )
      return { action: "handled" }
    }
  })
}

export default inputErgonomics
