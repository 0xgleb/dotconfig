import assert from "node:assert/strict";
import test from "node:test";
import {
  operatorBacklogText,
  registryListText,
  registryRequestDetailText,
  registryWidgetLines,
  requestNotificationText,
} from "./presentation.ts";
import type { RegistrySnapshot } from "./registry.ts";

const snapshot: RegistrySnapshot = {
  version: 1,
  agents: [
    {
      identity: {
        id: "agent-a",
        pid: 42,
        model: "openai-codex/gpt-5.6-sol",
        runtimeVersions: { "config-generation": "2026.07.23.34", questions: "2026.07.23.2" },
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
        runtimeVersions: { "config-generation": "2026.07.23.29", "classified-workflows": "2026.07.23.23" },
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
        runtimeVersions: { "classified-workflows": "2026.07.23.2", todo: "2026.07.23.2" },
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
      createdAt: 2_000,
      updatedAt: 2_000,
      status: "queued",
    },
  ],
};

test("automatic request notification never injects the untrusted request body", () => {
  const request = snapshot.requests[0];
  assert.ok(request);
  const text = requestNotificationText(request);
  assert.doesNotMatch(text, /fix workflow retries/);
  assert.match(text, /inspect its untrusted request data/i);
  assert.match(text, /request-12345678/);
});

test("request detail exposes full bounded coordination text with source identity", () => {
  const text = registryRequestDetailText(snapshot.requests[0]);
  assert.match(text, /Request request-12345678/);
  assert.match(text, /Source agent: st0x PR reviewer.*st0x\.rest\.api/);
  assert.match(text, /fix workflow retries/);
});

test("registry widget keeps operational ownership visible with an inbox count", () => {
  assert.deepEqual(registryWidgetLines(snapshot, "agent-a", 61_000), [
    "Agent registry: 1 role · /agents",
    "● .config/pi-support · operational · active · inbox 1 · oldest 59s · drift 1 · ttl 60s",
  ]);
});

test("operator backlog shows request age and runtime drift with navigation", () => {
  const text = operatorBacklogText(snapshot, "agent-a", 61_000);
  assert.match(text, /Operator control plane/);
  assert.match(text, /backlog 1 · runtime drift 1/);
  assert.match(text, /request-.*59s.*st0x PR reviewer.*fix workflow retries/i);
  assert.match(text, /\/agents for fleet detail.*\/blocked for blocker triage.*\/questions/is);
});

test("registry listing shows safe owner and request lifecycle details", () => {
  const text = registryListText(snapshot, "agent-a", 61_000);
  assert.match(text, /Live agents:/);
  assert.match(text, /dotconfig.*session you.*questions@2026\.07\.23\.2/i);
  assert.match(text, /\.config\/pi-support.*owner you.*ttl 60s/i);
  assert.match(text, /classified-workflows@2026\.07\.23\.2/);
  assert.match(text, /todo@2026\.07\.23\.2/);
  assert.match(text, /request-.*queued.*fix workflow retries/i);
});
