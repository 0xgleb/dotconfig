import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const manifest = readFileSync(
  new URL("../package.json", import.meta.url),
  "utf8",
)

test("request observability subscribes at extension load and exposes its log path", () => {
  assert.match(manifest, /\.\/request-observability\/index\.ts/u)
  assert.match(source, /channel\("pi\.request\.lifecycle"\)/u)
  assert.match(source, /installRequestLifecycleLogging/u)
  assert.match(source, /registerCommand\("request-log"/u)
  assert.match(source, /session_shutdown/u)
})
