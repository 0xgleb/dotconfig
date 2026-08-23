import assert from "node:assert/strict"
import test from "node:test"
import {
  boundedRegistryRequestPreview,
  operatorBacklogText,
  registryListText,
  registryRequestDetailText,
  registryWidgetLines,
  requestDeliveryStatus,
  requestNotificationDetails,
  requestNotificationDisplayText,
  requestNotificationText,
} from "./presentation.ts"
import {
  registrySnapshotForProject,
  terminalOutcomeBelongsToContext,
  type RegistrySnapshot,
} from "./registry.ts"

const snapshot: RegistrySnapshot = {
  version: 1,
  agents: [
    {
      identity: {
        id: "agent-a",
        pid: 42,
        model: "openai-codex/gpt-5.6-sol",
        runtimeVersions: {
          "config-generation": "2026.07.23.34",
          "questions": "2026.07.23.2",
        },
      },
      cwd: "/Users/example/.config",
      label: "dotconfig",
      heartbeatAt: 60_000,
      expiresAt: 121_000,
    },
    {
      identity: {
        id: "agent-b",
        pid: 43,
        runtimeVersions: {
          "config-generation": "2026.07.23.29",
          "classified-workflows": "2026.07.23.23",
        },
      },
      cwd: "/Users/example/code/st0x/st0x.rest.api",
      label: "st0x PR reviewer",
      heartbeatAt: 60_000,
      expiresAt: 121_000,
    },
  ],
  leases: [
    {
      id: "lease-1",
      project: "/Users/example/.config",
      role: "pi-support",
      mode: "operational",
      owner: {
        id: "agent-a",
        pid: 42,
        model: "openai-codex/gpt-5.6-sol",
        runtimeVersions: {
          "classified-workflows": "2026.07.23.2",
          "todo": "2026.07.23.2",
        },
      },
      policyDigest: "p1",
      acquiredAt: 1_000,
      heartbeatAt: 1_000,
      expiresAt: 121_000,
      status: "active",
    },
  ],
  requests: [
    {
      id: "request-12345678",
      project: "/Users/example/.config",
      role: "pi-support",
      requesterId: "agent-b",
      requesterLabel: "st0x PR reviewer",
      requesterCwd: "/Users/example/code/st0x/st0x.rest.api",
      text: "fix workflow retries",
      priority: "normal",
      createdAt: 2_000,
      updatedAt: 2_000,
      status: "queued",
    },
  ],
}

test("project scoping excludes unrelated agents, leases, and requests", () => {
  const scoped = registrySnapshotForProject(snapshot, "/Users/example/.config")
  assert.deepEqual(
    scoped.agents?.map(({ label }) => label),
    ["dotconfig"],
  )
  assert.deepEqual(
    scoped.leases.map(({ id }) => id),
    ["lease-1"],
  )
  assert.deepEqual(
    scoped.requests.map(({ id }) => id),
    ["request-12345678"],
  )
})

test("cross-project terminal outcomes never enter the requester conversation", () => {
  const request = snapshot.requests[0]
  assert.ok(request)
  assert.equal(
    terminalOutcomeBelongsToContext(
      request,
      "agent-b",
      "/Users/example/code/st0x/st0x.rest.api",
    ),
    false,
  )
  assert.equal(
    terminalOutcomeBelongsToContext(
      { ...request, requesterCwd: "/Users/example/.config" },
      "agent-b",
      "/Users/example/.config",
    ),
    true,
  )
})

test("outgoing request previews show useful content without rendering secret-shaped values", () => {
  assert.equal(
    boundedRegistryRequestPreview(
      "Fix the exact release test; token=super-secret-value and continue the gate",
      240,
    ),
    "Fix the exact release test; token=[redacted] and continue the gate",
  )
  assert.equal(
    boundedRegistryRequestPreview("First line\nSecond useful line", 240),
    "First line Second useful line",
  )
  assert.match(
    boundedRegistryRequestPreview("x".repeat(500), 80),
    /^x{77}\.\.\.$/,
  )
})

test("automatic request notification keeps the untrusted body out of model context", () => {
  const request = snapshot.requests[0]
  assert.ok(request)
  const text = requestNotificationText(request)
  assert.doesNotMatch(text, /fix workflow retries/)
  assert.match(text, /inspect its full untrusted request data/i)
  assert.match(text, /requests.*requestId=request-12345678/i)
  assert.doesNotMatch(text, /is claimed/i)
})

test("request receipt display leads with sender, target, and bounded message context", () => {
  const request = snapshot.requests[0]
  assert.ok(request)
  const details = requestNotificationDetails(request, 2)
  assert.deepEqual(details, {
    kind: "request-receipt",
    requestId: "request-12345678",
    sender: "st0x PR reviewer",
    senderProject: "st0x.rest.api",
    target: ".config/pi-support",
    preview: "fix workflow retries",
    olderQueued: 2,
  })

  const compact = requestNotificationDisplayText(details, false)
  assert.match(
    compact,
    /^st0x PR reviewer · st0x\.rest\.api → \.config\/pi-support/m,
  )
  assert.match(compact, /fix workflow retries/)
  assert.match(compact, /\+2 older queued · \/operator/)
  assert.doesNotMatch(
    compact,
    /agent_registry requests|Receipt does not claim|request-12345678/,
  )

  const expanded = requestNotificationDisplayText(details, true)
  assert.match(expanded, /request request-12345678 · received, not claimed/i)
  assert.match(expanded, /agent_registry requests requestId=request-12345678/i)
})

test("request receipt display compacts a long multiline body preview", () => {
  const request = snapshot.requests[0]
  assert.ok(request)
  const details = requestNotificationDetails(
    { ...request, text: `First useful line\n${"x".repeat(500)}` },
    0,
  )
  assert.equal(details.preview.includes("\n"), false)
  assert.ok(details.preview.length <= 240)
  assert.match(details.preview, /\.\.\.$/)
})

test("delivery state distinguishes persisted, received, and explicitly acknowledged requests", () => {
  const request = snapshot.requests[0]
  assert.ok(request)
  assert.equal(requestDeliveryStatus(request), "queued")
  assert.equal(
    requestDeliveryStatus({
      ...request,
      recipientReceivedAt: 2_100,
      recipientAgentId: "agent-a",
      recipientLeaseId: "lease-1",
    }),
    "received",
  )
  assert.equal(
    requestDeliveryStatus({
      ...request,
      status: "claimed",
      leaseId: "lease-1",
      agentId: "agent-a",
    }),
    "acknowledged",
  )
})

test("request detail exposes full bounded coordination text with source identity", () => {
  const text = registryRequestDetailText(snapshot.requests[0])
  assert.match(text, /Request request-12345678/)
  assert.match(text, /Source agent: st0x PR reviewer.*st0x\.rest\.api/)
  assert.match(text, /Priority: normal/)
  assert.match(text, /Delivery: queued/)
  assert.match(text, /fix workflow retries/)
})

test("request detail exposes bounded terminal outcomes as factual evidence", () => {
  const request = snapshot.requests[0]
  assert.ok(request)
  const completed = registryRequestDetailText({
    ...request,
    status: "completed",
    summary: "A",
    completedAt: 3_000,
    updatedAt: 3_000,
  })
  assert.match(
    completed,
    /Status: completed\nDelivery: acknowledged\nOutcome: A/,
  )
  const failed = registryRequestDetailText({
    ...request,
    status: "failed",
    failure: "blocked",
    diagnostic: "Awaiting exact evidence",
    completedAt: 3_000,
    updatedAt: 3_000,
  })
  assert.match(
    failed,
    /Status: failed\nDelivery: acknowledged\nOutcome: blocked: Awaiting exact evidence/,
  )
})

test("request detail does not compact an accepted 8k request body", () => {
  const request = snapshot.requests[0]
  assert.ok(request)
  const body = `begin:${"x".repeat(7_900)}:end`
  const text = registryRequestDetailText({ ...request, text: body })
  assert.match(text, /begin:x+/)
  assert.match(text, /:end$/)
  assert.ok(text.length > 7_900)
})

test("registry widget keeps operational ownership visible with an inbox count", () => {
  assert.deepEqual(registryWidgetLines(snapshot, "agent-a", 61_000), [
    "Agent registry: 1 role · /agents",
    "● .config/pi-support · operational · active · inbox 1 · oldest 59s · drift 1 · ttl 60s",
  ])
})

test("operator backlog shows request age and runtime drift with navigation", () => {
  const text = operatorBacklogText(snapshot, "agent-a", 61_000)
  assert.match(text, /Operator control plane/)
  assert.match(text, /backlog 1 · runtime drift 1/)
  assert.match(text, /request-.*59s.*st0x PR reviewer.*fix workflow retries/i)
  assert.match(
    text,
    /\/agents for fleet detail.*\/blocked for blocker triage.*\/questions/is,
  )
})

test("registry listing shows safe owner and request lifecycle details", () => {
  const text = registryListText(snapshot, "agent-a", 61_000)
  assert.match(text, /Live agents:/)
  assert.match(text, /dotconfig.*session you.*questions@2026\.07\.23\.2/i)
  assert.match(text, /\.config\/pi-support.*owner you.*ttl 60s/i)
  assert.match(text, /classified-workflows@2026\.07\.23\.2/)
  assert.match(text, /todo@2026\.07\.23\.2/)
  assert.match(text, /request-.*queued.*delivery queued.*fix workflow retries/i)
  assert.match(text, /inspect exact body.*requests requestId=/i)
})
