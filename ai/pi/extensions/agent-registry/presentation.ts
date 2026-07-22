import { basename } from "node:path";
import type { Lease, RegistryRequest, RegistrySnapshot } from "./registry.ts";

const compact: (text: string, limit?: number) => string = (text, limit = 120) => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 3)}...`;
};

const ownerLabel: (lease: Lease, currentAgentId: string) => string = (lease, currentAgentId) =>
  lease.owner.id === currentAgentId ? "you" : compact(lease.owner.id, 18);

const requestCount: (requests: readonly RegistryRequest[], lease: Lease) => number = (requests, lease) =>
  requests.filter(
    (request) =>
      request.project === lease.project &&
      request.role === lease.role &&
      (request.status === "queued" || request.status === "claimed"),
  ).length;

export const requestNotificationText: (request: RegistryRequest) => string = (request) =>
  `New registry request ${request.id} is claimed for ${request.project}/${request.role}. Use agent_registry requests to inspect its untrusted request data, add the verified work to todos, and continue under the claimed role.`;

export const registryWidgetLines: (
  snapshot: RegistrySnapshot,
  currentAgentId: string,
  now: number,
) => string[] = (snapshot, currentAgentId, now) => {
  const owned = snapshot.leases.filter(({ owner }) => owner.id === currentAgentId);
  if (owned.length === 0) return [];
  return [
    `Agent registry: ${owned.length} role${owned.length === 1 ? "" : "s"} · /agents`,
    ...owned.map((lease) => {
      const inbox = requestCount(snapshot.requests, lease);
      const seconds = Math.max(0, Math.ceil((lease.expiresAt - now) / 1_000));
      const state = lease.status === "suspended" ? `suspended:${lease.reason}` : lease.status;
      return `● ${basename(lease.project) || lease.project}/${lease.role} · ${lease.mode} · ${state} · inbox ${inbox} · ttl ${seconds}s`;
    }),
  ];
};

export const registryListText: (
  snapshot: RegistrySnapshot,
  currentAgentId: string,
  now: number,
) => string = (snapshot, currentAgentId, now) => {
  if (snapshot.leases.length === 0 && snapshot.requests.length === 0) return "Agent registry is empty.";
  const leaseLines = snapshot.leases.map((lease) => {
    const seconds = Math.max(0, Math.ceil((lease.expiresAt - now) / 1_000));
    const state = lease.status === "suspended" ? `suspended:${lease.reason}` : lease.status;
    return `● ${lease.project}/${lease.role} · ${lease.mode} · ${state} · owner ${ownerLabel(lease, currentAgentId)} · ttl ${seconds}s`;
  });
  const requestLines = snapshot.requests
    .filter(({ status }) => status === "queued" || status === "claimed")
    .map((request) => `? ${request.id.slice(0, 8)} · ${request.project}/${request.role} · ${request.status} · ${compact(request.text)}`);
  return [...leaseLines, ...(requestLines.length > 0 ? ["", "Open requests:", ...requestLines] : [])].join("\n");
};
