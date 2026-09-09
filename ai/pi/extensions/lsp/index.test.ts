import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8")

test("managed package enables the preview-first LSP tool without OMP dependencies", () => {
  const manifest = JSON.parse(read("../package.json")) as {
    dependencies?: Record<string, string>
    pi?: { extensions?: string[] }
  }
  assert.ok(manifest.pi?.extensions?.includes("./lsp/index.ts"))
  assert.equal(
    Object.keys(manifest.dependencies ?? {}).some(name =>
      name.startsWith("@oh-my-pi/"),
    ),
    false,
  )

  const source = read("./index.ts")
  assert.match(source, /"rename_preview"/u)
  assert.match(source, /"code_action_preview"/u)
  assert.match(source, /"apply"/u)
  assert.match(source, /exact previewId/u)
  assert.doesNotMatch(source, /raw_request|workspace\/executeCommand/u)
})
