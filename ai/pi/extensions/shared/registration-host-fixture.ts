import { registerHooks } from "node:module"

/** Host registration scaffolding only; schema calls are captured, not validated. */
export const installRegistrationHost = () => {
  const modules = new Map([
    ["@earendil-works/pi-coding-agent", 'export const CONFIG_DIR_NAME = "pi"'],
    ["@earendil-works/pi-tui", "export class Text {}"],
    [
      "typebox",
      `export const Type = Object.fromEntries(
        ["Object", "Union", "Literal", "Optional", "Array", "String", "Integer", "Number", "Boolean", "Null"]
          .map(kind => [kind, (...parameters) => ({ kind, parameters })])
      )`,
    ],
  ])
  return registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const source = modules.get(specifier)
      return source === undefined
        ? nextResolve(specifier, context)
        : {
            url: `data:text/javascript,${encodeURIComponent(source)}`,
            shortCircuit: true,
          }
    },
  })
}
