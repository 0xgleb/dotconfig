import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  getPackageDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import registryExtension from "./index.ts"

test("actual SDK registry registration exposes the exact-selection boolean to the model", async () => {
  const root = getPackageDir()
  const loader = await import(
    pathToFileURL(join(root, "dist", "core", "extensions", "loader.js")).href
  )
  const busModule = await import(
    pathToFileURL(join(root, "dist", "core", "event-bus.js")).href
  )
  let parameters: unknown
  let description: string | undefined
  let guidelines: readonly string[] = []
  let snippet = ""
  await loader.loadExtensionFromFactory(
    (pi: ExtensionAPI) => {
      registryExtension({
        ...pi,
        registerTool: definition => {
          if (definition.name === "agent_registry") {
            parameters = definition.parameters
            description = definition.description
            guidelines = definition.promptGuidelines ?? []
            snippet = definition.promptSnippet ?? ""
          }
          pi.registerTool(definition)
        },
      })
    },
    process.cwd(),
    busModule.createEventBus(),
    loader.createExtensionRuntime(),
    "registry-selection-schema.test",
  )
  assert.ok(
    typeof parameters === "object" &&
      parameters !== null &&
      "properties" in parameters,
  )
  const properties = parameters.properties
  assert.ok(
    typeof properties === "object" &&
      properties !== null &&
      "includeSelection" in properties,
    "registered schema must expose includeSelection",
  )
  assert.deepEqual(properties.includeSelection, { type: "boolean" })
  assert.match(description ?? "", /includeSelection/)
  assert.match(description ?? "", /unsupported-identity/)
  assert.match(
    guidelines[0] ?? "",
    /Read\/report-only manager sessions use registry list\/requests only/,
  )
  assert.match(snippet, /read\/report-only managers may only inspect/)
})
