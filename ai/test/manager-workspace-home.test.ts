import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("Home Manager installs the manager settings at its permanent workspace", () => {
  const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
  assert.ok(
    home.includes(
      '".config/ai/pi/workspaces/manager/.pi/settings.json".source',
    ),
  )
  assert.ok(
    !home.includes('".pi/agent/manager/global/.pi/settings.json".source'),
  )
  assert.ok(home.includes("${aiDir}/pi/manager.settings.json"))
})
