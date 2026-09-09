import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")

test("fleet diagnostics expose current behavior-bearing component versions", () => {
  assert.match(
    read("../pi/extensions/shared/runtime-version.ts"),
    /MANAGED_CONFIG_GENERATION = "2026\.07\.23\.136"/,
  )
  assert.match(
    read("../pi/extensions/activity-status/index.ts"),
    /activity-status", "2026\.08\.20\.1"/,
  )
  assert.match(
    read("../pi/extensions/agent-registry/index.ts"),
    /agent-registry", "2026\.09\.04\.2"/,
  )
  assert.match(
    read("../pi/extensions/agent-workspace/index.ts"),
    /agent-workspace", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/auto-reload/index.ts"),
    /auto-reload", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/write-result-inspector/index.ts"),
    /write-result-inspector", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/browser-control/index.ts"),
    /browser-control", "2026\.09\.04\.2"/,
  )
  assert.match(read("../pi/extensions/btw/index.ts"), /btw", "2026\.07\.23\.1"/)
  assert.match(
    read("../pi/extensions/classified-workflows/index.ts"),
    /classified-workflows", "2026\.09\.04\.2"/,
  )
  assert.match(
    read("../pi/extensions/compact-read/index.ts"),
    /compact-read", "2026\.08\.09\.1"/,
  )
  assert.match(
    read("../pi/extensions/link-safety/index.ts"),
    /link-safety", "2026\.07\.23\.1"/,
  )
  assert.match(read("../pi/extensions/lsp/index.ts"), /lsp", "2026\.09\.04\.1"/)
  assert.match(
    read("../pi/extensions/nushell-default/index.ts"),
    /nushell-default", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/questions/index.ts"),
    /questions", "2026\.09\.03\.1"/,
  )
  assert.match(
    read("../pi/extensions/pi-vim/index.ts"),
    /pi-vim", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/release-cadence/index.ts"),
    /release-cadence", "2026\.08\.09\.4"/,
  )
  assert.match(
    read("../pi/extensions/remote-control/index.ts"),
    /remote-control", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/disk-pressure/index.ts"),
    /resource-pressure", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/image-summary/index.ts"),
    /image-summary", "2026\.08\.14\.2"/,
  )
  assert.match(
    read("../pi/extensions/safe-compaction/index.ts"),
    /safe-compaction", "2026\.08\.23\.1"/,
  )
  assert.match(
    read("../pi/extensions/todo/index.ts"),
    /todo", "2026\.09\.04\.1"/,
  )
  assert.match(
    read("../pi/extensions/usage-governor/index.ts"),
    /usage-governor", "2026\.09\.04\.1"/,
  )
})
