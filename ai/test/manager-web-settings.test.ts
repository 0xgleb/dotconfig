import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const managerSettings = (): unknown =>
  JSON.parse(
    readFileSync(
      new URL("../pi/manager.settings.json", import.meta.url),
      "utf8",
    ),
  )

test("manager web tools use the pinned upstream package", () => {
  const settings = managerSettings()
  assert.ok(typeof settings === "object" && settings !== null)
  assert.ok("packages" in settings)
  assert.deepEqual(settings.packages, ["npm:pi-unsloth-webtools@0.11.0"])
})

test("manager web configuration restricts fetching to public web content", () => {
  const settings = managerSettings()
  assert.ok(typeof settings === "object" && settings !== null)
  assert.ok("unslothWebTools" in settings)
  assert.deepEqual(settings.unslothWebTools, {
    allowLocalFiles: false,
    allowPrivateAddresses: false,
    lightpandaEnabled: false,
    lightpandaFallback: false,
    transport: "off",
    engines: ["duckduckgo"],
    maxResults: 5,
    maxChars: 20000,
    timeoutMs: 15000,
  })
})

test("Home Manager links manager-only package settings to the permanent workspace", () => {
  const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
  assert.ok(
    home.includes(
      '".config/ai/pi/workspaces/manager/.pi/settings.json".source',
    ),
  )
  assert.ok(home.includes("${aiDir}/pi/manager.settings.json"))
})
