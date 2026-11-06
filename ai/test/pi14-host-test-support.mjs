import { createRequire, registerHooks } from "node:module"

// Test-only host aliases; no installation or active dependency changes.
const hostRoot =
  "/nix/store/zh4ybfar6v4j7n4f87z44zc39ry0yl4k-pi-coding-agent-1.4.0/lib/node_modules/pi-monorepo"
const host = createRequire(`${hostRoot}/package.json`)
const aliases = {
  "typebox": host.resolve("typebox"),
  "@earendil-works/pi-tui": host.resolve("@earendil-works/pi-tui"),
  "@earendil-works/pi-ai": `${hostRoot}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  "@earendil-works/pi-coding-agent": `${hostRoot}/dist/index.js`,
}

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    const hostImport = context.parentURL?.startsWith(`file://${hostRoot}/`)

    return nextResolve(
      hostImport ? specifier : (aliases[specifier] ?? specifier),
      context,
    )
  },
})
