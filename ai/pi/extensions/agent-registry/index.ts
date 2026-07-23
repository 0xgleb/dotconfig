import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Effect } from "effect";
import { isContinuationPaused } from "../shared/continuation-pause.ts";
import {
  REGISTRY_INTENT_REQUEST_EVENT,
  type RegistryIntentRequest,
} from "../shared/registry-intent-events.ts";
import {
  MANAGED_CONFIG_GENERATION,
  piHostRuntimeVersions,
  registerRuntimeVersion,
  RUNTIME_VERSION_REQUEST_EVENT,
  type RuntimeVersionReporter,
} from "../shared/runtime-version.ts";
import { makeSqliteRegistryStore } from "./sqlite-store.ts";
import { managedOperationalRole, registryStateRoot, shouldSelfClaimUnownedRole } from "./paths.ts";
import {
  registryListText,
  registryRequestDetailText,
  registryWidgetLines,
  requestNotificationText,
} from "./presentation.ts";
import {
  reconcileSessionLease,
  RegistryError,
  runRegistryEffect,
  type AgentIdentity,
  type Lease,
  type RegistryRequest,
  type RegistrySnapshot,
} from "./registry.ts";

const SYNC_MS = 5_000;
const LEASE_TTL_MS = 90_000;
const STATUS_KEY = "agent-registry";
const MESSAGE_TYPE = "agent-registry.message";
const NOTIFIED_REQUESTS_ENTRY = "agent-registry.notified-requests";

interface RegistryToolRequest {
  readonly action:
    | "list"
    | "claim"
    | "release"
    | "delegate"
    | "requests"
    | "claim_request"
    | "complete_request"
    | "fail_request"
    | "cancel_request";
  readonly project?: string;
  readonly role?: string;
  readonly mode?: "task" | "operational";
  readonly requestId?: string;
  readonly text?: string;
  readonly summary?: string;
  readonly failure?: "blocked" | "cancelled" | "error" | "timed_out";
  readonly diagnostic?: string;
}

const policyDigest: (ctx: ExtensionContext) => string = (ctx) =>
  createHash("sha256").update(ctx.getSystemPrompt()).digest("hex");

const sessionIdentity: (ctx: ExtensionContext, runtimeVersions: Readonly<Record<string, string>>) => AgentIdentity = (
  ctx,
  runtimeVersions,
) => ({
  id: ctx.sessionManager.getSessionId(),
  pid: process.pid,
  ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
  runtimeVersions,
});

const safeErrorMessage: (error: unknown) => string = (error) =>
  error instanceof RegistryError
    ? `${error.code}: ${error.message}`.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240)
    : "Agent registry operation failed";

const requireText: (label: string, value: string | undefined) => string = (label, value) => {
  const trimmed = value?.trim();
  if (!trimmed) throw new RegistryError({ code: "invalid_input", message: `${label} required` });
  return trimmed;
};

const registryExtension: (pi: ExtensionAPI) => void = (pi) => {
  registerRuntimeVersion(pi, "agent-registry", "2026.07.23.6");
  const runtimeVersions = (): Readonly<Record<string, string>> => {
    const versions: Record<string, string> = {
      "config-generation": MANAGED_CONFIG_GENERATION,
      ...piHostRuntimeVersions(process.argv[1]),
    };
    const report: RuntimeVersionReporter = (component, version) => {
      versions[component] = version;
    };
    pi.events.emit(RUNTIME_VERSION_REQUEST_EVENT, report);
    return Object.fromEntries(Object.entries(versions).sort(([left], [right]) => left.localeCompare(right)));
  };
  const identity = (ctx: ExtensionContext): AgentIdentity => sessionIdentity(ctx, runtimeVersions());
  const store = makeSqliteRegistryStore(registryStateRoot(process.env.XDG_STATE_HOME, homedir()));
  let timer: ReturnType<typeof setInterval> | undefined;
  let sessionPolicyDigest: string | undefined;
  let syncing = false;
  let latestSnapshot: RegistrySnapshot | undefined;
  let lastSyncError: string | undefined;
  const notifiedRequests = new Set<string>();

  const restoreNotifiedRequests = (ctx: ExtensionContext) => {
    notifiedRequests.clear();
    const entry = ctx.sessionManager
      .getBranch()
      .filter((candidate) => candidate.type === "custom" && candidate.customType === NOTIFIED_REQUESTS_ENTRY)
      .at(-1);
    if (entry?.type !== "custom" || typeof entry.data !== "object" || entry.data === null || !("ids" in entry.data)) return;
    const ids = entry.data.ids;
    if (!Array.isArray(ids) || ids.length > 512) return;
    for (const id of ids) {
      if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) notifiedRequests.add(id);
    }
  };

  const persistNotifiedRequests = () => {
    pi.appendEntry(NOTIFIED_REQUESTS_ENTRY, { ids: [...notifiedRequests].slice(-512).sort() });
  };

  const run = <T>(operation: Effect.Effect<T, RegistryError>): Promise<T> => runRegistryEffect(operation);

  const currentPolicyDigest = (ctx: ExtensionContext): string => sessionPolicyDigest ?? policyDigest(ctx);

  pi.events.on(
    REGISTRY_INTENT_REQUEST_EVENT,
    (payload: RegistryIntentRequest) => {
      if (
        !latestSnapshot ||
        typeof payload !== "object" ||
        payload === null ||
        typeof payload.agentId !== "string" ||
        typeof payload.report !== "function"
      ) {
        return;
      }
      const leases = latestSnapshot.leases.filter((lease) => lease.owner.id === payload.agentId);
      for (const lease of leases) {
        const requestIds = latestSnapshot.requests
          .filter(
            (request) =>
              request.status === "claimed" && request.leaseId === lease.id && request.agentId === payload.agentId,
          )
          .map((request) => request.id);
        payload.report(
          `Trusted live registry assignment: ${lease.project}/${lease.role} (${lease.mode}, ${lease.status})${
            requestIds.length > 0 ? `; claimed request IDs: ${requestIds.join(", ")}` : ""
          }`,
        );
      }
    },
  );

  const ownedLeases = (snapshot: RegistrySnapshot, agentId: string): readonly Lease[] =>
    snapshot.leases.filter(({ owner }) => owner.id === agentId);

  const render = (ctx: ExtensionContext, snapshot: RegistrySnapshot) => {
    const lines = registryWidgetLines(snapshot, identity(ctx).id, Date.now());
    ctx.ui.setStatus(STATUS_KEY, lines.length > 0 ? `roles:${ownedLeases(snapshot, identity(ctx).id).length}` : undefined);
    if (ctx.hasUI) ctx.ui.setWidget(STATUS_KEY, lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
  };

  const notifyRequest = async (ctx: ExtensionContext, request: RegistryRequest): Promise<void> => {
    if (notifiedRequests.has(request.id) || !ctx.isIdle()) return;
    const fresh = (await run(store.snapshot(Date.now()))).requests.find(({ id }) => id === request.id);
    if (
      !fresh ||
      fresh.status !== "claimed" ||
      fresh.leaseId !== request.leaseId ||
      fresh.agentId !== identity(ctx).id ||
      !ctx.isIdle()
    ) {
      return;
    }
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: requestNotificationText(fresh),
        display: true,
      },
      isContinuationPaused(ctx.sessionManager.getBranch())
        ? undefined
        : { triggerTurn: true, deliverAs: "followUp" },
    );
    notifiedRequests.add(fresh.id);
    persistNotifiedRequests();
  };

  const sync = async (ctx: ExtensionContext, notificationsEnabled = true) => {
    if (syncing) return;
    syncing = true;
    const now = Date.now();
    const agent = identity(ctx);
    const digest = currentPolicyDigest(ctx);
    try {
      await run(
        store.heartbeatAgent({
          agent,
          cwd: ctx.cwd,
          label: pi.getSessionName() ?? ctx.cwd.split("/").at(-1) ?? "Pi agent",
          now,
          ttlMs: LEASE_TTL_MS,
        }),
      );
      let snapshot = await run(store.snapshot(now));
      for (const request of notificationsEnabled && ctx.isIdle()
        ? snapshot.requests.filter(
            (candidate) =>
              candidate.requesterId === agent.id &&
              candidate.requesterAcknowledgedAt === undefined &&
              (candidate.status === "completed" || candidate.status === "failed" || candidate.status === "cancelled"),
          )
        : []) {
        const outcome =
          request.status === "completed"
            ? request.summary
            : request.status === "failed"
              ? `${request.failure}: ${request.diagnostic}`
              : "cancelled";
        pi.sendMessage(
          {
            customType: MESSAGE_TYPE,
            content: `Registry request ${request.id} ${request.status}.\nOutcome: ${outcome}`,
            display: true,
          },
          isContinuationPaused(ctx.sessionManager.getBranch())
            ? undefined
            : { triggerTurn: true, deliverAs: "followUp" },
        );
        await run(store.acknowledgeRequest({ requestId: request.id, requesterId: agent.id, now }));
      }
      snapshot = await run(store.snapshot(now));
      for (const lease of ownedLeases(snapshot, agent.id)) {
        const paused = isContinuationPaused(ctx.sessionManager.getBranch());
        try {
          if (paused && lease.status === "active") {
            await run(store.pause({ leaseId: lease.id, agentId: agent.id, now }));
          } else if (!paused && lease.status === "paused") {
            await run(
              store.resume({
                leaseId: lease.id,
                agentId: agent.id,
                policyDigest: digest,
                runtimeVersions: agent.runtimeVersions,
                now,
                ttlMs: LEASE_TTL_MS,
              }),
            );
          } else if (!paused && lease.status === "active") {
            await run(
              store.heartbeat({
                leaseId: lease.id,
                agentId: agent.id,
                policyDigest: digest,
                runtimeVersions: agent.runtimeVersions,
                now,
                ttlMs: LEASE_TTL_MS,
              }),
            );
          }
        } catch (error) {
          if (!(error instanceof RegistryError) || error.code !== "stale_lease") throw error;
        }
      }

      snapshot = await run(store.snapshot(now));
      for (const lease of ownedLeases(snapshot, agent.id).filter(({ status }) => status === "active")) {
        const candidates = snapshot.requests.filter(
          (request) =>
            request.project === lease.project &&
            request.role === lease.role &&
            (request.status === "queued" || (request.status === "claimed" && request.leaseId !== lease.id)),
        );
        for (const request of candidates) {
          try {
            const claimed = await run(
              store.claimRequest({ requestId: request.id, leaseId: lease.id, agentId: agent.id, now }),
            );
            if (notificationsEnabled) await notifyRequest(ctx, claimed);
          } catch (error) {
            if (!(error instanceof RegistryError) || error.code !== "invalid_transition") throw error;
          }
        }
        for (const request of snapshot.requests.filter(
          (candidate) => candidate.status === "claimed" && candidate.leaseId === lease.id,
        )) {
          if (notificationsEnabled) await notifyRequest(ctx, request);
        }
      }
      snapshot = await run(store.snapshot(now));
      latestSnapshot = snapshot;
      render(ctx, snapshot);
      lastSyncError = undefined;
      ctx.ui.setStatus("agent-registry-error", undefined);
    } catch (error) {
      const message = safeErrorMessage(error);
      ctx.ui.setStatus("agent-registry-error", `registry:${error instanceof RegistryError ? error.code : "error"}`);
      if (message !== lastSyncError) {
        lastSyncError = message;
        ctx.ui.notify(`Agent registry: ${message}`, "error");
      }
    } finally {
      syncing = false;
    }
  };

  const autoClaimOperationalRole = async (ctx: ExtensionContext) => {
    const managed = managedOperationalRole(ctx.cwd, homedir());
    if (!managed) return;
    await run(
      reconcileSessionLease({
        store,
        agent: identity(ctx),
        project: managed.project,
        role: managed.role,
        mode: "operational",
        policyDigest: currentPolicyDigest(ctx),
        now: Date.now(),
        ttlMs: LEASE_TTL_MS,
      }),
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    restoreNotifiedRequests(ctx);
    sessionPolicyDigest = policyDigest(ctx);
    await autoClaimOperationalRole(ctx).catch((error) => {
      ctx.ui.notify(`Could not claim managed operational role: ${safeErrorMessage(error)}`, "warning");
    });
    await sync(ctx, false);
    timer = setInterval(() => void sync(ctx), SYNC_MS);
    timer.unref?.();
  });

  pi.on("session_compact", () => persistNotifiedRequests());

  pi.on("agent_settled", async (_event, ctx) => {
    await sync(ctx);
  });

  const showRegistry = async (ctx: ExtensionContext) => {
    const now = Date.now();
    const snapshot = await run(store.snapshot(now));
    pi.sendMessage({ customType: MESSAGE_TYPE, content: registryListText(snapshot, identity(ctx).id, now), display: true });
  };

  pi.on("input", async (event, ctx) => {
    if (event.text.trim() === "/agents") {
      await showRegistry(ctx);
      return { action: "handled" };
    }
    queueMicrotask(() => void sync(ctx));
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const snapshot = await run(store.snapshot(Date.now())).catch(() => undefined);
    if (!snapshot) return;
    const leases = ownedLeases(snapshot, identity(ctx).id);
    if (leases.length === 0) return;
    return {
      message: {
        customType: "agent-registry.context",
        content: `Registry roles owned by this session:\n${leases
          .map((lease) => `- ${lease.project}/${lease.role}: ${lease.mode}, ${lease.status}`)
          .join("\n")}\nOperational roles remain active even when their inbox is empty.`,
        display: false,
      },
      systemPrompt: event.systemPrompt,
    };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    sessionPolicyDigest = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setStatus("agent-registry-error", undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
    if (event.reason === "reload") return;
    const agent = identity(ctx);
    const snapshot = await run(store.snapshot(Date.now())).catch(() => undefined);
    if (!snapshot) return;
    for (const lease of ownedLeases(snapshot, agent.id)) {
      await run(store.release({ leaseId: lease.id, agentId: agent.id, now: Date.now() })).catch(() => undefined);
    }
  });

  pi.registerCommand("agents", {
    description: "Show local Pi agent role leases and open delegated requests",
    async handler(_args, ctx) {
      await showRegistry(ctx);
    },
  });

  pi.registerTool({
    name: "agent_registry",
    label: "Agent registry",
    description: "Claim local project roles and exchange durable requests with other Pi sessions. Roles route work but grant no authority.",
    promptSnippet: "Discover local Pi role owners, claim unowned duties, and delegate durable requests",
    promptGuidelines: [
      "Delegate Pi host, extension, TUI, classifier, reload, or operator bugs encountered outside ~/.config to /Users/0xgleb/.config, role pi-support, without self-claiming that dedicated role; then continue the primary task unless blocked.",
      "If a non-dedicated role is unowned, claim it temporarily and handle the request in the current session by default.",
      "Registry ownership never grants tools or production authority; constrained project tools and loaded instructions remain authoritative.",
      "Operational roles do not become complete merely because todos or inboxes are empty.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("claim"),
        Type.Literal("release"),
        Type.Literal("delegate"),
        Type.Literal("requests"),
        Type.Literal("claim_request"),
        Type.Literal("complete_request"),
        Type.Literal("fail_request"),
        Type.Literal("cancel_request"),
      ]),
      project: Type.Optional(Type.String()),
      role: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("operational")])),
      requestId: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      failure: Type.Optional(
        Type.Union([Type.Literal("blocked"), Type.Literal("cancelled"), Type.Literal("error"), Type.Literal("timed_out")]),
      ),
      diagnostic: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, request: RegistryToolRequest, _signal, _onUpdate, ctx) {
      const now = Date.now();
      const agent = identity(ctx);
      const project = request.project?.trim() || ctx.cwd;
      try {
        if (request.action === "list" || request.action === "requests") {
          const snapshot = await run(store.snapshot(now));
          const requested = request.requestId?.trim();
          const matches = requested
            ? snapshot.requests.filter(({ id }) => id === requested || id.startsWith(requested))
            : [];
          if (requested && matches.length !== 1) {
            throw new RegistryError({
              code: matches.length === 0 ? "not_found" : "invalid_input",
              message: matches.length === 0 ? "request not found" : "request prefix is ambiguous",
            });
          }
          return {
            content: [
              {
                type: "text",
                text: matches[0] ? registryRequestDetailText(matches[0]) : registryListText(snapshot, agent.id, now),
              },
            ],
            details: { outcome: "success", action: request.action, snapshot },
          };
        }

        if (request.action === "claim") {
          const role = requireText("role", request.role);
          const result = await run(
            store.claim({
              agent,
              project,
              role,
              mode: request.mode ?? "task",
              policyDigest: currentPolicyDigest(ctx),
              now,
              ttlMs: LEASE_TTL_MS,
            }),
          );
          await sync(ctx);
          return {
            content: [{ type: "text", text: result.outcome === "claimed" ? `Claimed ${project}/${role}` : `${project}/${role} is owned by ${result.lease.owner.id}` }],
            details: { outcome: result.outcome, lease: result.lease },
          };
        }

        if (request.action === "release") {
          const role = requireText("role", request.role);
          const snapshot = await run(store.snapshot(now));
          const lease = ownedLeases(snapshot, agent.id).find(
            (candidate) => candidate.project === project && candidate.role === role,
          );
          if (!lease) throw new RegistryError({ code: "stale_lease", message: "this session does not own the requested role" });
          await run(store.release({ leaseId: lease.id, agentId: agent.id, now }));
          await sync(ctx);
          return {
            content: [{ type: "text", text: `Released ${lease.project}/${lease.role}` }],
            details: { outcome: "released", lease },
          };
        }

        if (request.action === "delegate") {
          const role = requireText("role", request.role);
          const text = requireText("text", request.text);
          let snapshot = await run(store.snapshot(now));
          let lease = snapshot.leases.find((candidate) => candidate.project === project && candidate.role === role);
          let outcome: "delegated" | "queued_unowned" | "self_claimed" = lease ? "delegated" : "queued_unowned";
          if (!lease && shouldSelfClaimUnownedRole(project, role, ctx.cwd, homedir())) {
            const claim = await run(
              store.claim({ agent, project, role, mode: request.mode ?? "task", policyDigest: currentPolicyDigest(ctx), now, ttlMs: LEASE_TTL_MS }),
            );
            lease = claim.lease;
            outcome = lease.owner.id === agent.id ? "self_claimed" : "delegated";
          }
          const queued = await run(
            store.enqueue({
              project,
              role,
              requesterId: agent.id,
              requesterLabel: pi.getSessionName() ?? ctx.cwd.split("/").at(-1) ?? "Pi agent",
              requesterCwd: ctx.cwd,
              text,
              now,
            }),
          );
          let durableRequest = queued;
          if (lease?.owner.id === agent.id && lease.status === "active") {
            durableRequest = await run(
              store.claimRequest({ requestId: queued.id, leaseId: lease.id, agentId: agent.id, now }),
            );
            notifiedRequests.add(queued.id);
            persistNotifiedRequests();
          }
          snapshot = await run(store.snapshot(now));
          render(ctx, snapshot);
          return {
            content: [
              {
                type: "text",
                text: outcome === "self_claimed"
                  ? `No live owner existed; self-claimed ${project}/${role}. Request ${queued.id} is yours to add to todos and execute.`
                  : outcome === "queued_unowned"
                    ? `Queued request ${queued.id} for the standing ${project}/${role} operator; do not duplicate it locally.`
                    : `Queued request ${queued.id} for ${project}/${role}, owned by ${lease?.owner.id}.`,
              },
            ],
            details: { outcome, request: durableRequest, lease },
          };
        }

        const requestId = requireText("requestId", request.requestId);
        const snapshot = await run(store.snapshot(now));
        const target = snapshot.requests.find(({ id }) => id === requestId);
        if (!target) throw new RegistryError({ code: "not_found", message: "request not found" });

        if (request.action === "cancel_request") {
          const cancelled = await run(store.cancelRequest({ requestId, requesterId: agent.id, now }));
          await run(store.acknowledgeRequest({ requestId, requesterId: agent.id, now }));
          await sync(ctx);
          return { content: [{ type: "text", text: `Cancelled request ${requestId}` }], details: { outcome: "cancelled", request: cancelled } };
        }

        const lease = ownedLeases(snapshot, agent.id).find(
          (candidate) => candidate.project === target.project && candidate.role === target.role,
        );
        if (!lease) throw new RegistryError({ code: "stale_lease", message: "this session does not own the request role" });

        if (request.action === "claim_request") {
          const claimed = await run(store.claimRequest({ requestId, leaseId: lease.id, agentId: agent.id, now }));
          notifiedRequests.add(requestId);
          persistNotifiedRequests();
          return { content: [{ type: "text", text: `Claimed request ${requestId}` }], details: { outcome: "claimed", request: claimed } };
        }
        if (request.action === "complete_request") {
          const completed = await run(
            store.completeRequest({ requestId, leaseId: lease.id, agentId: agent.id, summary: requireText("summary", request.summary), now }),
          );
          if (completed.requesterId === agent.id) {
            await run(store.acknowledgeRequest({ requestId, requesterId: agent.id, now }));
          }
          await sync(ctx);
          return { content: [{ type: "text", text: `Completed request ${requestId}` }], details: { outcome: "completed", request: completed } };
        }
        if (request.action === "fail_request") {
          const failed = await run(
            store.failRequest({
              requestId,
              leaseId: lease.id,
              agentId: agent.id,
              failure: request.failure ?? "error",
              diagnostic: requireText("diagnostic", request.diagnostic),
              now,
            }),
          );
          if (failed.requesterId === agent.id) {
            await run(store.acknowledgeRequest({ requestId, requesterId: agent.id, now }));
          }
          await sync(ctx);
          return { content: [{ type: "text", text: `Failed request ${requestId}` }], details: { outcome: "failed", request: failed } };
        }
        throw new RegistryError({ code: "invalid_input", message: "unsupported registry action" });
      } catch (error) {
        const message = safeErrorMessage(error);
        return { content: [{ type: "text", text: message }], details: { outcome: "error", action: request.action, error: message } };
      }
    },
  });
};

export default registryExtension;
