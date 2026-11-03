import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")

const components = [
  ["activity-status", "activity-status"],
  ["agent-registry", "agent-registry"],
  ["agent-workspace", "agent-workspace"],
  ["auto-reload", "auto-reload"],
  ["write-result-inspector", "write-result-inspector"],
  ["browser-control", "browser-control"],
  ["classified-workflows", "classified-workflows"],
  ["compact-read", "compact-read"],
  ["lsp", "lsp"],
  ["nushell-default", "nushell-default"],
  ["questions", "questions"],
  ["pi-vim", "pi-vim"],
  ["release-cadence", "release-cadence"],
  ["remote-control", "remote-control"],
  ["disk-pressure", "resource-pressure"],
  ["image-summary", "image-summary"],
  ["safe-compaction", "safe-compaction"],
  ["todo", "todo"],
  ["usage-governor", "usage-governor"],
] as const

for (const [directory, component] of components) {
  test(`${component} declares a named runtime version marker`, () => {
    assert.match(
      read(`../pi/extensions/${directory}/index.ts`),
      new RegExp(
        `registerRuntimeVersion\\(pi, "${component}", "\\d{4}\\.\\d{2}\\.\\d{2}\\.\\d+"\\)`,
        "u",
      ),
    )
  })
}

test("fleet diagnostics retain the managed configuration generation", () => {
  assert.match(
    read("../pi/extensions/shared/runtime-version.ts"),
    /MANAGED_CONFIG_GENERATION = "2026\.07\.23\.161"/,
  )
})

test("the classifier runtime marker identifies the retry-budget revision", () => {
  assert.match(
    read("../pi/extensions/classified-workflows/index.ts"),
    /classified-workflows", "2026\.10\.17\.28"/,
  )
})
