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

test("resource warnings automatically route typed agentops incidents", () => {
  assert.match(source, /AGENTOPS_INCIDENT_EVENT/)
  assert.match(
    source,
    /component: "resource-pressure"[\s\S]*?operation[\s\S]*?summary/,
  )
  assert.match(source, /Disk pressure is below the crash reserve/)
  assert.match(source, /Memory pressure is below the crash reserve/)
  assert.match(source, /reportIncident\("error", "post-build cleanup"/)
})

test("critical memory incidents steer the active session instead of waiting passively", () => {
  assert.match(source, /customType: "resource-pressure\.incident"/)
  assert.match(source, /triggerTurn: true, deliverAs: "steer"/)
  assert.match(source, /This is an actionable incident, not a passive warning/)
  assert.match(
    source,
    /Bounded RSS aggregate \(command names only; no arguments\)/,
  )
})

test("critical disk incidents proactively assign cleanup before another build", () => {
  assert.match(source, /const reconcileDiskIncident/)
  assert.match(source, /reconcileDiskIncident\(ctx, available\)/)
  assert.match(source, /Critical disk-pressure incident/)
  assert.match(source, /Clean only verified inactive rebuildable/)
  assert.match(source, /triggerTurn: true, deliverAs: "steer"/)
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

test("failed remediation delivery releases its incident lease", () => {
  assert.match(source, /deliverResourceIncident/)
  assert.match(
    source,
    /Either\.isLeft\(delivery\)[\s\S]*?clearResourceIncident\(DISK_INCIDENT_PATH\)[\s\S]*?deliver disk remediation/,
  )
  assert.match(
    source,
    /Either\.isLeft\(delivery\)[\s\S]*?clearResourceIncident\(MEMORY_INCIDENT_PATH\)[\s\S]*?deliver memory remediation/,
  )
})

test("concurrent builds cannot claim each other's result symlinks", () => {
  assert.match(source, /pending => pending\.cwd === ctx\.cwd/)
  assert.match(source, /concurrent\.cleanupResultLinks = false/)
  assert.match(source, /cleanupResultLinks: concurrentBuilds\.length === 0/)
  assert.match(
    source,
    /pending\.cleanupResultLinks[\s\S]*?cleanupNewResultSymlinks/,
  )
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
