import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const skill = readFileSync(
  new URL("../skills/register/SKILL.md", import.meta.url),
  "utf8",
)

// Documentation contracts, not substitutes for bridge lifecycle tests.
test("native registration and inbox ownership stay with the extension", () => {
  const native = skill.split("**Native Pi path.**")[1]?.split("**Roster.**")[0]
  assert.ok(native, "register must define the native path before CLI setup")
  assert.match(native, /remote-control extension.*registers, polls, claims,/s)
  assert.match(native, /completes bridge messages/s)
  assert.match(native, /session UUID, not.*display label/s)
  assert.match(
    native,
    /Do not run.*`pi-bridge register`.*`pi-bridge inbox`.*`pi-bridge respond`/s,
  )
  assert.match(
    native,
    /CLI heartbeat and re-arm procedures below\s+apply only to external lanes/s,
  )
})

test("native bridge failures do not disable independent typed registry work", () => {
  const native = skill.split("**Native Pi path.**")[1]?.split("**Roster.**")[0]
  assert.ok(native)
  assert.match(native, /`agent_registry`.*routed requests/s)
  assert.match(native, /separate stores and identities/s)
  assert.match(native, /not proof of bridge readiness/s)
  assert.match(
    native,
    /continue independently authorized.*typed registry work/s,
  )
  assert.match(native, /never create a replacement CLI registration/s)
})

test("manual inbox claiming is limited to external cli-poll lanes", () => {
  const drain = skill
    .split("## Drain one iteration")[1]
    ?.split("2. **Reprioritize")[0]
  assert.ok(drain)
  assert.match(
    drain,
    /For external `cli-poll` lanes only, drain the bridge inbox first/,
  )
  assert.match(
    drain,
    /Native Pi's remote-control extension handles this automatically/,
  )
  assert.match(
    drain,
    /`inline-only` and `monitor-only`\s+lanes must not claim messages/,
  )
  assert.match(drain, /pi-bridge inbox --agent <your-agent-id>/)
  assert.doesNotMatch(drain, /For `native-pi` and `cli-poll`, drain/)
})

test("native outcomes use typed transitions without a second CLI envelope", () => {
  const report = skill.split("4. **Report.")[1]?.split("5. **Yield")[0]
  assert.ok(report)
  assert.match(
    report,
    /Native Pi records request outcomes through `agent_registry`/,
  )
  assert.match(report, /`complete_request` \/ `fail_request`/)
  assert.match(report, /do not send a second CLI outcome envelope/)
  assert.match(report, /External CLI workers report one outcome envelope/)
})
