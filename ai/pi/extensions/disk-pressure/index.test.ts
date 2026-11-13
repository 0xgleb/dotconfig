import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const classifiedSource = readFileSync(
  new URL("../classified-workflows/index.ts", import.meta.url),
  "utf8",
)
const capacitySource = readFileSync(
  new URL("../shared/memory-capacity.ts", import.meta.url),
  "utf8",
)

test("macOS capacity uses the shared pressure-aware provider instead of raw free pages", () => {
  assert.match(
    source,
    /import \{ availableMemoryBytes \} from "\.\.\/shared\/memory-capacity\.ts"/,
  )
  assert.match(source, /availableMemoryBytes\(\)/)
  assert.doesNotMatch(source, /\bfreemem\b/)
  assert.match(capacitySource, /memory_pressure", \["-Q"\]/)
  assert.match(capacitySource, /parseMemoryPressureCapacity\(result\.stdout\)/)
  assert.match(source, /only.*available.*reserve/is)
})

test("disk blocks direct standing-authority cleanup and exact uncertain-state verification", () => {
  assert.match(source, /standing exact cleanup authority/)
  assert.match(source, /dust or Nushell/)
  assert.match(source, /preserve configured live outputs/)
  assert.match(
    source,
    /independently verify the exact path after uncertain execution/,
  )
  assert.match(source, /continue the blocked gate/)
})

test("classified expensive commands use a fresh authoritative resource preflight", () => {
  assert.match(source, /RESOURCE_PREFLIGHT_REQUEST_EVENT/)
  assert.match(source, /resourcePressureSnapshot/)
  assert.match(classifiedSource, /RESOURCE_PREFLIGHT_REQUEST_EVENT/)
  assert.match(classifiedSource, /resourcePreflightDisprovesBlock/)
  assert.match(classifiedSource, /resourcePreflightBlockMessage/)
  const deterministicBlock = classifiedSource.indexOf(
    "const resourceBlock = resourcePreflightBlockMessage",
  )
  const modelClassification = classifiedSource.indexOf(
    "const decision = await classifyWithActivity",
    deterministicBlock,
  )
  assert.ok(deterministicBlock >= 0 && modelClassification > deterministicBlock)
})
