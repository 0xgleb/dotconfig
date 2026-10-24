import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const productionSources = [
  new URL("./backlog.ts", import.meta.url),
  new URL("./backlog-collector.ts", import.meta.url),
  new URL("./backlog-ingest-tool.ts", import.meta.url),
  new URL("./sqlite-store.ts", import.meta.url),
  new URL("../shared/backlog-events.ts", import.meta.url),
  new URL("../shared/backlog-source-adapters.ts", import.meta.url),
] as const

test("durable backlog production code never throws", () => {
  for (const source of productionSources) {
    const text = readFileSync(source, "utf8")
    assert.doesNotMatch(text, /\bthrow\b/u, source.pathname)
  }
})
