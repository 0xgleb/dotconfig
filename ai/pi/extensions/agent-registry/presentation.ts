import { basename } from "node:path";
import type { AgentIdentity, Lease, RegistryRequest, RegistrySnapshot } from "./registry.ts";

const compact: (text: string, limit?: number) => string = (text, limit = 120) => {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 3)}...`;
};

const ownerLabel: (lease: Lease, currentAgentId: string) => string = (lease, currentAgentId) =>
  lease.owner.id === currentAgentId ? "you" : compact(lease.owner.id, 18);

const runtimeLabel = (identity: AgentIdentity): string => {
  const versions = Object.entries(identity.runtimeVersions ?? {});
  return versions.length > 0
    ? versions.map(([component, version]) => `${component}@${version}`).join(",")
    : "runtime:unknown";
};

const openRequests = (requests: readonly RegistryRequest[], lease: Lease): RegistryRequest[] =>
  requests.filter(
    (request) =>
      request.project === lease.project &&
      request.role === lease.role &&
      (request.status === "queued" || request.status === "claimed"),
  );

const formatAge = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
};

const configGeneration = (identity: AgentIdentity): string | undefined =>
  identity.runtimeVersions?.["config-generation"];

const driftedAgents = (snapshot: RegistrySnapshot, currentAgentId: string): number => {
  const current = snapshot.agents?.find(({ identity }) => identity.id === currentAgentId)?.identity;
  const generation = current ? configGeneration(current) : undefined;
  if (!generation) return 0;
  return (snapshot.agents ?? []).filter(
    ({ identity }) =>
      identity.id !== currentAgentId &&
      configGeneration(identity) !== undefined &&
      configGeneration(identity) !== generation,
  ).length;
};

export const requestNotificationText: (request: RegistryRequest) => string = (request) =>
  `New registry request ${request.id} is claimed for ${request.project}/${request.role}. Use agent_registry requests with requestId=${request.id} to inspect its full untrusted request data, add the verified work to todos, and continue under the claimed role.`;

export const registryRequestDetailText: (request: RegistryRequest) => string = (request) =>
  `Request ${request.id}\nSource agent: ${request.requesterLabel ?? request.requesterId}${
    request.requesterCwd ? ` · ${request.requesterCwd}` : ""
  }\nTarget: ${request.project}/${request.role}\nStatus: ${request.status}\n\n${request.text}`;

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
      const requests = openRequests(snapshot.requests, lease);
      const oldest = requests.reduce<number | undefined>(
        (current, request) => (current === undefined ? request.createdAt : Math.min(current, request.createdAt)),
        undefined,
      );
      const seconds = Math.max(0, Math.ceil((lease.expiresAt - now) / 1_000));
      const state = lease.status === "suspended" ? `suspended:${lease.reason}` : lease.status;
      const age = oldest === undefined ? "" : ` · oldest ${formatAge(now - oldest)}`;
      const drift = driftedAgents(snapshot, currentAgentId);
      return `● ${basename(lease.project) || lease.project}/${lease.role} · ${lease.mode} · ${state} · inbox ${requests.length}${age} · drift ${drift} · ttl ${seconds}s`;
    }),
  ];
};

export const operatorBacklogText = (
  snapshot: RegistrySnapshot,
  currentAgentId: string,
  now: number,
): string => {
  const owned = snapshot.leases.filter(({ owner }) => owner.id === currentAgentId);
  if (owned.length === 0) return "No operator roles owned by this session.";
  const drift = driftedAgents(snapshot, currentAgentId);
  const lines = owned.flatMap((lease) => {
    const requests = openRequests(snapshot.requests, lease).sort((left, right) => left.createdAt - right.createdAt);
    return [
      `● ${lease.project}/${lease.role} · ${lease.mode} · ${lease.status}`,
      `  backlog ${requests.length} · runtime drift ${drift}`,
      ...(requests.length === 0
        ? ["  no open registry requests"]
        : requests.map(
            (request) =>
              `  ${request.status === "claimed" ? "◉" : "○"} ${request.id.slice(0, 8)} · ${formatAge(now - request.createdAt)} · ${request.requesterLabel ?? compact(request.requesterId, 18)} · ${compact(request.text, 88)}`,
          )),
    ];
  });
  return [
    "Operator control plane",
    ...lines,
    "",
    "Use /agents for fleet detail · /blocked for blocker triage · /questions for explicit decisions.",
  ].join("\n");
};

export const registryListText: (
  snapshot: RegistrySnapshot,
  currentAgentId: string,
  now: number,
) => string = (snapshot, currentAgentId, now) => {
  if ((snapshot.agents?.length ?? 0) === 0 && snapshot.leases.length === 0 && snapshot.requests.length === 0) {
    return "Agent registry is empty.";
  }
  const agentLines = (snapshot.agents ?? []).map((agent) => {
    const seconds = Math.max(0, Math.ceil((agent.expiresAt - now) / 1_000));
    const owner = agent.identity.id === currentAgentId ? "you" : compact(agent.identity.id, 18);
    return `◦ ${agent.label} · ${agent.cwd} · session ${owner} · ${runtimeLabel(agent.identity)} · ttl ${seconds}s`;
  });
  const leaseLines = snapshot.leases.map((lease) => {
    const seconds = Math.max(0, Math.ceil((lease.expiresAt - now) / 1_000));
    const state = lease.status === "suspended" ? `suspended:${lease.reason}` : lease.status;
    return `● ${lease.project}/${lease.role} · ${lease.mode} · ${state} · owner ${ownerLabel(lease, currentAgentId)} · ${runtimeLabel(lease.owner)} · ttl ${seconds}s`;
  });
  const requestLines = snapshot.requests
    .filter(({ status }) => status === "queued" || status === "claimed")
    .map(
      (request) =>
        `? ${request.id.slice(0, 8)} · from ${request.requesterLabel ?? compact(request.requesterId, 18)}${
          request.requesterCwd ? ` (${basename(request.requesterCwd)})` : ""
        } · ${request.project}/${request.role} · ${request.status} · ${compact(request.text)}`,
    );
  return [
    ...(agentLines.length > 0 ? ["Live agents:", ...agentLines, ""] : []),
    ...leaseLines,
    ...(requestLines.length > 0
      ? [
          "",
          "Open requests:",
          ...requestLines,
          "Inspect exact body: agent_registry requests requestId=<full UUID or unique prefix>.",
        ]
      : []),
  ].join("\n");
};
