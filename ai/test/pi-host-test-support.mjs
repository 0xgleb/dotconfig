// Match the installed Pi 1.3 loader, using real host dependencies in tests.
import { createRequire, registerHooks } from "node:module"

const hostRoot =
  "/nix/store/nxskv7qzx13yi7a6q1fwwqiykhmjgjib-pi-coding-agent-1.3.0/lib/node_modules/pi-monorepo"
const host = createRequire(`${hostRoot}/package.json`)
const aliases = {
  "typebox": host.resolve("typebox"),
  "@earendil-works/pi-tui": host.resolve("@earendil-works/pi-tui"),
  "@earendil-works/pi-ai": `${hostRoot}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
  "@earendil-works/pi-coding-agent": `${hostRoot}/dist/index.js`,
}

registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(aliases[specifier] ?? specifier, context),
})

export const loadHostExtension = async path => {
  const { createJiti } = await import(
    `${hostRoot}/dist/core/extensions/jiti-loader.js`
  )
  return createJiti(import.meta.url, {
    alias: aliases,
    moduleCache: false,
    fsCache: false,
  }).import(path, { default: true })
}
