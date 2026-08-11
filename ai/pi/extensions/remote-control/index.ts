import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { wasRunAborted } from "../shared/continuation-pause.ts";
import { isLocalDispatchProvider } from "../shared/local-lane.ts";
import {
  REGISTRY_DELEGATE_REQUEST_EVENT,
  REGISTRY_OUTCOME_EVENT,
  REGISTRY_PROJECTS_REQUEST_EVENT,
  type RegistryDelegateOutcome,
  type RegistryDelegateRequest,
  type RegistryOutcomeRequest,
  type RegistryOutcomeResult,
  type RegistryProjectsRequest,
} from "../shared/registry-intent-events.ts";
import {
  QUESTION_REMOTE_RESOLUTION_EVENT,
  QUESTION_STATE_EVENT,
  type RemoteUserQuestionResolution,
  type UserQuestionStateSnapshot,
} from "../shared/question-events.ts";
import {
  REMOTE_CAPABILITY_HANDSHAKE_EVENT,
  REMOTE_CAPABILITY_MESSAGE,
  REMOTE_TASK_CONTINUATION_MESSAGE,
  remoteCapabilityMessage,
  type RemoteCapabilityHandshake,
} from "../shared/remote-capability.ts";
import {
  REGISTRY_IDENTITY_REQUEST_EVENT,
  type RegistryIdentityRequest,
  type RegistryRoleIdentity,
} from "../shared/registry-intent-events.ts";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import { agentDisplayLabel } from "./agent-identity.ts";
import {
  deliverOwnerRelay,
  type OwnerRelayDeliveryError,
} from "./owner-telegram.ts";
import { remoteBridgeDatabasePath } from "./paths.ts";
import { remoteKanbanResponse } from "./remote-commands.ts";
import {
  canClaimRemoteTurn,
  settleTaskContinuation,
  type TaskContinuationPhase,
} from "./routing-gate.ts";
import {
  BRIDGE_AGENT_TTL_MS,
  BRIDGE_MESSAGE_TTL_MS,
  RemoteBridgeError,
  dispatchSystemPrompt,
  finalAssistantText,
  mechanicalDispatchCompaction,
  normalizeLegacyRemoteImageContent,
  ownerRelayCompletion,
  parseOutcomeEnvelope,
  parseOwnerRelay,
  parseRoutePlan,
  routingBatchPrompt,
  remoteTurnContent,
  trimDispatchContext,
  type OutcomeEnvelope,
  type OwnerRelayDelivery,
  type RemoteFailure,
  type RemoteMessage,
} from "./protocol.ts";
import {
  attachmentRefusal,
  ownerPaneDedupeKey,
  routedBundle,
  routingDelegations,
  routingRoster,
  turnClaims,
  type RoutableProject,
  type RoutingDelegation,
} from "./routing-plan.ts";
import { makeRemoteBridgeStore } from "./sqlite-store.ts";
import { enterRemoteToolGuard, type RemoteToolGuard } from "./tool-guard.ts";

const POLL_MS = 2_000;
const STATUS_KEY = "remote-control";
const DISPATCH_CONTEXT_BUDGET_CHARS = 100_000;
const MAX_TRACKED_PANE_MESSAGES = 64;
const MAX_DISPATCH_BATCH_MESSAGES = 16;
const REGISTRY_DELEGATE_BUDGET_MS = 5_000;
const REGISTRY_OUTCOME_BUDGET_MS = 5_000;
const REGISTRY_PROJECTS_BUDGET_MS = 3_000;

interface ClaimedBridgeMessage {
  readonly id: string;
  readonly claimToken: string;
  /**
   * Bridge requester id of the claimed row, carried because an outcome
   * envelope is only entitled to close the registry request that same
   * requester was assigned. Narrowing this shape without it silently reports
   * every receiver outcome as coming from nobody.
   */
  readonly requesterId: string;
  readonly text: string;
}

type PaneMessageOutcome =
  | { readonly outcome: "routed"; readonly response: string }
  | { readonly outcome: "dropped"; readonly reason: string };

type DispatchDrain = "drained" | "claim_failed";

interface ActiveRemoteTurn {
  readonly messageId: string;
  readonly claimToken: string;
  readonly toolGuard: RemoteToolGuard;
  readonly lane: "conversational" | "routing";
  readonly text: string;
  readonly batch?: readonly ClaimedBridgeMessage[];
  /**
   * Projects that can actually take work, each carrying the receiver it would
   * be delegated to: live roster entries other than this session, plus
   * registry projects whose receiver is merely between polls. Captured when
   * the turn opens so routing decides - and records its assignment - against
   * the roster the model was actually shown.
   */
  readonly routable?: readonly RoutableProject[];
}

const safeError = (error: RemoteBridgeError): string =>
  `${error.code}: ${error.message}`.slice(0, 160);

const safeDeliveryError = (error: OwnerRelayDeliveryError): string =>
  `${error.code}: ${error.message}`.slice(0, 160);

export default function remoteControl(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "remote-control", "2026.08.11.1");
  const store = makeRemoteBridgeStore(
    remoteBridgeDatabasePath(process.env.XDG_STATE_HOME, homedir()),
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let latestCtx: ExtensionContext | undefined;
  let syncing = false;
  let active: ActiveRemoteTurn | undefined;
  let taskContinuationPhase: TaskContinuationPhase = "idle";
  let taskContinuationId: string | undefined;
  let questionState: UserQuestionStateSnapshot = { questions: [] };
  let questionsDirty = false;
  let paneSubmissions = 0;

  const run = <A, E>(
    operation: Effect.Effect<A, E>,
  ): Promise<Either.Either<A, E>> =>
    Effect.runPromise(Effect.either(operation));

  /**
   * One round trip over a mechanical registry event: emit the request, wait
   * for the extension to report through the callback, and fall back to a
   * bounded failure when nothing answers within the budget. Written once and
   * in Effect so the wait is interruptible and no site is left holding a live
   * timer of its own after the drain that opened it is gone.
   */
  const askRegistry = <Request, Result>(
    event: string,
    request: (report: (result: Result) => void) => Request,
    onTimeout: () => Result,
    budgetMs: number,
  ): Effect.Effect<Result> =>
    Effect.async<Result>((resume) => {
      pi.events.emit(
        event,
        request((result) => resume(Effect.succeed(result))),
      );
    }).pipe(
      Effect.timeoutTo({
        duration: budgetMs,
        onSuccess: (result: Result) => result,
        onTimeout,
      }),
    );

  pi.events.on(QUESTION_STATE_EVENT, (snapshot: UserQuestionStateSnapshot) => {
    questionState = snapshot;
    questionsDirty = true;
  });

  /**
   * Pane input is consumed into the bridge queue, so the pane is the one
   * surface that would otherwise never learn what became of its own message:
   * bridge completions are only read back by the Telegram daemon, and then
   * only for rows that daemon enqueued. Rows this session took from the pane
   * are remembered until they reach a terminal state and reported back here.
   */
  const paneMessages = new Set<string>();

  const trackPaneMessage = (messageId: string): void => {
    if (paneMessages.size >= MAX_TRACKED_PANE_MESSAGES) {
      const oldest = paneMessages.values().next().value;
      if (oldest !== undefined) paneMessages.delete(oldest);
    }
    paneMessages.add(messageId);
  };

  const reportPaneOutcome = (
    messageId: string,
    result: PaneMessageOutcome,
  ): void => {
    if (!paneMessages.delete(messageId)) return;
    if (result.outcome === "routed") {
      latestCtx?.ui.notify(`Pane message: ${result.response}`);
      return;
    }
    latestCtx?.ui.notify(`Pane message not routed: ${result.reason}`, "warning");
  };

  const clearActive = (turn: ActiveRemoteTurn): void => {
    if (active !== turn) return;
    const handshake: RemoteCapabilityHandshake = turn.toolGuard.restore();
    active = undefined;
    pi.sendMessage({
      customType: REMOTE_CAPABILITY_MESSAGE,
      content: remoteCapabilityMessage(handshake),
      display: false,
    });
    pi.events.emit(REMOTE_CAPABILITY_HANDSHAKE_EVENT, handshake);
    latestCtx?.ui.setStatus(
      STATUS_KEY,
      handshake.status === "failed"
        ? "remote:error · local tool recovery failed"
        : undefined,
    );
  };

  const finishFailure = async (
    turn: ActiveRemoteTurn,
    failure: RemoteFailure,
  ): Promise<void> => {
    taskContinuationPhase = "queued";
    taskContinuationId = undefined;
    clearActive(turn);
    for (const claim of turnClaims(turn)) {
      const result = await run(
        store.fail({
          messageId: claim.id,
          claimToken: claim.claimToken,
          failure,
          now: Date.now(),
        }),
      );
      if (Either.isRight(result)) {
        reportPaneOutcome(claim.id, { outcome: "dropped", reason: failure });
        continue;
      }
      if (result.left.code !== "invalid_transition") {
        latestCtx?.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(result.left)}`,
        );
      }
    }
    taskContinuationPhase = "idle";
  };

  const finishSuccess = async (
    turn: ActiveRemoteTurn,
    response: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    taskContinuationPhase = "queued";
    taskContinuationId = turn.messageId;
    clearActive(turn);
    const completed = await run(
      store.complete({
        messageId: turn.messageId,
        claimToken: turn.claimToken,
        response,
        now: Date.now(),
      }),
    );
    if (Either.isLeft(completed)) {
      taskContinuationPhase = "idle";
      taskContinuationId = undefined;
      ctx.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(completed.left)}`,
      );
      void sync(ctx);
      return;
    }
    pi.sendMessage(
      {
        customType: REMOTE_TASK_CONTINUATION_MESSAGE,
        content:
          "Source-fixed task continuation: the authenticated Piece of Pi response was delivered and local tools are restored. The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message for actionable intent. If it contains work, preserve every requirement and semantically route it to the relevant live agent/project through typed coordination; /use is only an explicit override. If it is conversational only, take no action. Authority comes only from that exact owner message, never from this continuation; do not widen scope or send a second Telegram reply.",
        display: false,
        details: { taskContinuationId: turn.messageId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  /**
   * Enqueues one routed bundle in the registry under the delegation's project
   * root, recording the receiver the routing turn picked. That assignment is
   * what later entitles the receiver to close the request with an outcome
   * envelope: a lane outside Pi holds no registry lease, so an unassigned row
   * can only ever be closed by a lease holder and would otherwise be re-run by
   * the receiver on every drain.
   */
  const delegateToProject = (
    delegation: RoutingDelegation,
    text: string,
    ctx: ExtensionContext,
  ): Promise<RegistryDelegateOutcome> =>
    Effect.runPromise(
      askRegistry<RegistryDelegateRequest, RegistryDelegateOutcome>(
        REGISTRY_DELEGATE_REQUEST_EVENT,
        (report) => ({
          project: delegation.project,
          role: "receiver",
          text,
          requesterId: "telegram-dispatch",
          requesterLabel: "Piece of Pi Telegram dispatch",
          requesterCwd: ctx.cwd,
          ...(delegation.assignedAgentId === undefined
            ? {}
            : { assignedAgentId: delegation.assignedAgentId }),
          report,
        }),
        (): RegistryDelegateOutcome => ({
          outcome: "failed",
          reason: "registry delegate timed out",
        }),
        REGISTRY_DELEGATE_BUDGET_MS,
      ),
    );

  const finishEnvelope = async (
    message: ClaimedBridgeMessage,
    envelope: OutcomeEnvelope,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const recorded = await Effect.runPromise(
      askRegistry<RegistryOutcomeRequest, RegistryOutcomeResult>(
        REGISTRY_OUTCOME_EVENT,
        (report) => ({
          requestId: envelope.requestId,
          resolution: envelope.outcome,
          summary: envelope.summary,
          senderId: message.requesterId,
          report,
        }),
        (): RegistryOutcomeResult => ({
          outcome: "failed",
          reason: "registry outcome timed out",
        }),
        REGISTRY_OUTCOME_BUDGET_MS,
      ),
    );
    const body =
      envelope.outcome === "failed"
        ? `Receiver failed request ${envelope.requestId}: ${envelope.summary}`
        : envelope.summary;
    const suffix =
      recorded.outcome === "failed"
        ? ` (registry record pending: ${recorded.reason})`
        : "";
    const response = `${body}${suffix}`;
    const completed = await run(
      store.complete({
        messageId: message.id,
        claimToken: message.claimToken,
        response,
        now: Date.now(),
      }),
    );
    if (Either.isLeft(completed)) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(completed.left)}`,
      );
      return;
    }
    reportPaneOutcome(message.id, { outcome: "routed", response });
  };

  const finishRouting = async (
    turn: ActiveRemoteTurn,
    response: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const batch = turn.batch ?? [];
    const routable = turn.routable ?? [];
    const plan = parseRoutePlan(
      response,
      batch.length,
      routable.map(({ project }) => project),
    );
    const delegations = routingDelegations(plan, {
      size: batch.length,
      routable,
      dispatcherProject: ctx.cwd,
    });
    const texts = batch.map(({ text }) => text);
    const acks = new Map<number, string[]>();
    for (const delegation of delegations) {
      const outcome = await delegateToProject(
        delegation,
        routedBundle(delegation, texts),
        ctx,
      );
      const ack =
        outcome.outcome === "queued"
          ? `${delegation.project} (request ${outcome.requestId})`
          : `${delegation.project} FAILED: ${outcome.reason}`;
      for (const index of delegation.indexes) {
        acks.set(index, [...(acks.get(index) ?? []), ack]);
      }
    }
    clearActive(turn);
    for (const [position, message] of batch.entries()) {
      const destinations = acks.get(position + 1) ?? [
        "nowhere - no live agent owns a project for this message",
      ];
      const completion = `Routed to ${destinations.join("; ")}.`;
      const completed = await run(
        store.complete({
          messageId: message.id,
          claimToken: message.claimToken,
          response: completion,
          now: Date.now(),
        }),
      );
      if (Either.isLeft(completed)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(completed.left)}`,
        );
        continue;
      }
      reportPaneOutcome(message.id, { outcome: "routed", response: completion });
    }
  };

  const beginTurn = async (
    message: Extract<RemoteMessage, { readonly status: "claimed" }>,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const turn: ActiveRemoteTurn = {
      messageId: message.id,
      claimToken: message.claimToken,
      toolGuard: enterRemoteToolGuard(pi),
      lane: "conversational",
      text: message.text,
    };
    active = turn;
    ctx.ui.setStatus(STATUS_KEY, "remote:chat · tools:off");
    const content = remoteTurnContent(message.text, message.images);
    const sent = await Effect.runPromise(
      Effect.either(
        Effect.try({
          try: () =>
            pi.sendUserMessage(content, {
              deliverAs: "steer",
            }),
          catch: () =>
            new RemoteBridgeError({
              code: "io",
              message: "could not start remote turn",
            }),
        }),
      ),
    );
    if (Either.isLeft(sent)) await finishFailure(turn, "model_error");
  };

  /**
   * Registry leases expire in ninety seconds while receivers poll hours apart,
   * so the live-agent roster alone would hide every project between polls and
   * the batch would fall back to the dispatcher's own project. A timeout or an
   * unavailable registry reports nothing and the roster stays live-only.
   */
  const knownProjects = (): Promise<readonly string[]> =>
    Effect.runPromise(
      askRegistry<RegistryProjectsRequest, readonly string[]>(
        REGISTRY_PROJECTS_REQUEST_EVENT,
        (report) => ({ report }),
        (): readonly string[] => [],
        REGISTRY_PROJECTS_BUDGET_MS,
      ),
    );

  const beginRoutingTurn = async (
    batch: readonly ClaimedBridgeMessage[],
    ctx: ExtensionContext,
  ): Promise<void> => {
    const first = batch[0];
    if (!first) return;
    const turn: ActiveRemoteTurn = {
      messageId: first.id,
      claimToken: first.claimToken,
      toolGuard: enterRemoteToolGuard(pi),
      lane: "routing",
      text: first.text,
      batch,
    };
    active = turn;
    ctx.ui.setStatus(
      STATUS_KEY,
      `remote:routing · ${batch.length} msg · tools:off`,
    );
    // The roster is this turn's whole picture of who can take work, so a store
    // read that failed is not an empty roster: routing on it would report every
    // message as owned by nobody, or hand the batch to whichever project
    // survived the gap. The turn is abandoned instead and its rows fail, which
    // tells the sender something went wrong rather than inventing a decision.
    const roster = await run(store.listAgents(Date.now()));
    if (Either.isLeft(roster)) {
      ctx.ui.setStatus(STATUS_KEY, `remote:error · ${safeError(roster.left)}`);
      await finishFailure(turn, "model_error");
      return;
    }
    const known = await knownProjects();
    const routing = routingRoster({
      live: roster.right.map(({ id, label, cwd }) => ({ id, label, cwd })),
      known,
      dispatcherAgentId: ctx.sessionManager.getSessionId(),
    });
    const routingTurn: ActiveRemoteTurn = {
      ...turn,
      routable: routing.routable,
    };
    active = routingTurn;
    const prompt = routingBatchPrompt(
      batch.map((message, position) => ({
        index: position + 1,
        text: message.text,
      })),
      routing.roster,
    );
    const sent = await run(
      Effect.try({
        try: () =>
          pi.sendUserMessage([{ type: "text", text: prompt }], {
            deliverAs: "steer",
          }),
        catch: () =>
          new RemoteBridgeError({
            code: "io",
            message: "could not start routing turn",
          }),
      }),
    );
    // A batch that never reached the model has no routing decision to record.
    // Completing it as routed would delegate up to a whole batch of owner
    // messages on a decision nobody made; failing every claimed row reports the
    // infrastructure failure the sender can act on.
    if (Either.isLeft(sent)) await finishFailure(routingTurn, "model_error");
  };

  const bridgeAgentLabel = (ctx: ExtensionContext): string => {
    const roles: RegistryRoleIdentity[] = [];
    const request: RegistryIdentityRequest = {
      agentId: ctx.sessionManager.getSessionId(),
      report: (identity) => roles.push(identity),
    };
    pi.events.emit(REGISTRY_IDENTITY_REQUEST_EVENT, request);
    return agentDisplayLabel(
      pi.getSessionName() ?? ctx.cwd.split("/").at(-1) ?? "Pi agent",
      roles,
    );
  };

  const sync = async (ctx: ExtensionContext): Promise<void> => {
    if (syncing) return;
    syncing = true;
    latestCtx = ctx;
    try {
      const now = Date.now();
      const heartbeat = await run(
        store.heartbeatAgent({
          id: ctx.sessionManager.getSessionId(),
          label: bridgeAgentLabel(ctx),
          cwd: ctx.cwd,
          accepting: active === undefined,
          now,
          ttlMs: BRIDGE_AGENT_TTL_MS,
        }),
      );
      if (Either.isLeft(heartbeat)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(heartbeat.left)}`,
        );
        return;
      }

      if (questionsDirty) {
        const questionSync = await run(
          store.syncQuestions({
            agentId: ctx.sessionManager.getSessionId(),
            questions: questionState.questions,
            now,
          }),
        );
        if (Either.isLeft(questionSync)) {
          ctx.ui.setStatus(
            STATUS_KEY,
            `remote:error · ${safeError(questionSync.left)}`,
          );
          return;
        }
        questionsDirty = false;
      }

      const resolution = await run(
        store.takeQuestionResolution({
          agentId: ctx.sessionManager.getSessionId(),
          now,
        }),
      );
      if (Either.isLeft(resolution)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(resolution.left)}`,
        );
        return;
      }
      if (resolution.right) {
        const answer: RemoteUserQuestionResolution = {
          id: resolution.right.questionId,
          answer: resolution.right.answer,
        };
        pi.events.emit(QUESTION_REMOTE_RESOLUTION_EVENT, answer);
      }

      if (!canClaimRemoteTurn(active !== undefined, taskContinuationPhase))
        return;
      if (isLocalDispatchProvider(ctx.model?.provider)) {
        const batch: ClaimedBridgeMessage[] = [];
        let drain: DispatchDrain = "drained";
        while (batch.length < MAX_DISPATCH_BATCH_MESSAGES) {
          const claimed = await run(
            store.claimNext({
              agentId: ctx.sessionManager.getSessionId(),
              now: Date.now(),
            }),
          );
          if (Either.isLeft(claimed)) {
            drain = "claim_failed";
            ctx.ui.setStatus(
              STATUS_KEY,
              `remote:error · ${safeError(claimed.left)}`,
            );
            break;
          }
          if (claimed.right?.status !== "claimed") break;
          const message: ClaimedBridgeMessage = {
            id: claimed.right.id,
            claimToken: claimed.right.claimToken,
            requesterId: claimed.right.requesterId,
            text: claimed.right.text,
          };
          const attachments = claimed.right.images;
          const envelope = parseOutcomeEnvelope(message.text);
          if (envelope) {
            await finishEnvelope(message, envelope, ctx);
            continue;
          }
          const relay = parseOwnerRelay(message.text);
          if (relay) {
            const sent = await run(deliverOwnerRelay(relay));
            const delivery: OwnerRelayDelivery = Either.isLeft(sent)
              ? {
                  outcome: "undelivered",
                  reason: safeDeliveryError(sent.left),
                }
              : { outcome: "delivered" };
            const response = ownerRelayCompletion(relay, delivery);
            const relayed = await run(
              store.complete({
                messageId: message.id,
                claimToken: message.claimToken,
                response,
                now: Date.now(),
              }),
            );
            if (Either.isLeft(relayed))
              ctx.ui.setStatus(
                STATUS_KEY,
                `remote:error · ${safeError(relayed.left)}`,
              );
            else reportPaneOutcome(message.id, { outcome: "routed", response });
            continue;
          }
          if (message.text.trim() === "/kanban") {
            const completed = await run(
              store.complete({
                messageId: message.id,
                claimToken: message.claimToken,
                response: remoteKanbanResponse(ctx.sessionManager.getBranch()),
                now: Date.now(),
              }),
            );
            if (Either.isLeft(completed))
              ctx.ui.setStatus(
                STATUS_KEY,
                `remote:error · ${safeError(completed.left)}`,
              );
            continue;
          }
          if (attachments.length > 0) {
            const refusal = attachmentRefusal(attachments.length);
            const refused = await run(
              store.complete({
                messageId: message.id,
                claimToken: message.claimToken,
                response: refusal,
                now: Date.now(),
              }),
            );
            if (Either.isLeft(refused))
              ctx.ui.setStatus(
                STATUS_KEY,
                `remote:error · ${safeError(refused.left)}`,
              );
            else
              reportPaneOutcome(message.id, {
                outcome: "dropped",
                reason: refusal,
              });
            continue;
          }
          batch.push(message);
        }
        if (batch.length > 0) await beginRoutingTurn(batch, ctx);
        else if (drain === "drained") ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const claimed = await run(
        store.claimNext({ agentId: ctx.sessionManager.getSessionId(), now }),
      );
      if (Either.isLeft(claimed)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(claimed.left)}`,
        );
        return;
      }
      if (claimed.right?.status === "claimed") {
        if (claimed.right.text.trim() === "/kanban") {
          const completed = await run(
            store.complete({
              messageId: claimed.right.id,
              claimToken: claimed.right.claimToken,
              response: remoteKanbanResponse(ctx.sessionManager.getBranch()),
              now: Date.now(),
            }),
          );
          if (Either.isLeft(completed))
            ctx.ui.setStatus(
              STATUS_KEY,
              `remote:error · ${safeError(completed.left)}`,
            );
        } else {
          await beginTurn(claimed.right, ctx);
        }
      } else ctx.ui.setStatus(STATUS_KEY, undefined);
    } finally {
      syncing = false;
    }
  };

  pi.on("context", (event, ctx) => {
    const messages = normalizeLegacyRemoteImageContent(event.messages);
    if (
      taskContinuationPhase === "queued" &&
      messages.some(
        (message) =>
          message.role === "custom" &&
          message.customType === REMOTE_TASK_CONTINUATION_MESSAGE &&
          message.details !== undefined &&
          typeof message.details === "object" &&
          "taskContinuationId" in message.details &&
          message.details.taskContinuationId === taskContinuationId,
      )
    )
      taskContinuationPhase = "running";
    if (isLocalDispatchProvider(ctx.model?.provider)) {
      const trimmed = trimDispatchContext(
        messages,
        DISPATCH_CONTEXT_BUDGET_CHARS,
        Date.now(),
      );
      return { messages: [...trimmed.messages] };
    }
    return { messages };
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (!isLocalDispatchProvider(ctx.model?.provider)) return undefined;
    return { compaction: mechanicalDispatchCompaction(event.preparation) };
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    if (timer) clearInterval(timer);
    timer = setInterval(() => void sync(ctx), POLL_MS);
    timer.unref();
    void sync(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    active?.toolGuard.enforce();
    if (isLocalDispatchProvider(ctx.model?.provider))
      return { systemPrompt: dispatchSystemPrompt(ctx.cwd) };
    return undefined;
  });

  /**
   * Owner text typed into the pane joins the bridge queue so the dispatch lane
   * drains it mechanically instead of letting the local model answer freehand.
   * Only `interactive` input may be intercepted: this extension's own
   * `sendUserMessage` routing prompts surface as input events too, and
   * re-enqueuing those would loop.
   *
   * An unusable bridge fails the input closed. Passing the text through would
   * hand it to the local model exactly when routing is least available and an
   * invented answer is most likely to be read as a report of work done.
   */
  pi.on("input", async (event, ctx) => {
    if (!isLocalDispatchProvider(ctx.model?.provider))
      return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };
    const text = event.text.trim();
    if (text.length === 0 || text.startsWith("/"))
      return { action: "continue" };
    paneSubmissions += 1;
    const enqueued = await run(
      store.enqueue({
        targetAgentId: ctx.sessionManager.getSessionId(),
        requesterId: "owner-pane",
        dedupeKey: ownerPaneDedupeKey({
          sessionId: ctx.sessionManager.getSessionId(),
          sequence: paneSubmissions,
          now: Date.now(),
        }),
        text,
        now: Date.now(),
        ttlMs: BRIDGE_MESSAGE_TTL_MS,
      }),
    );
    if (Either.isLeft(enqueued)) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(enqueued.left)}`,
      );
      ctx.ui.notify(
        `Pane message rejected: ${safeError(enqueued.left)}. The dispatch lane never answers pane input itself - resend once the bridge recovers.`,
        "error",
      );
      return { action: "handled" };
    }
    trackPaneMessage(enqueued.right.id);
    void sync(ctx);
    return { action: "handled" };
  });

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    const turn = active;
    if (!turn) return;
    if (wasRunAborted([event.message])) {
      await finishFailure(turn, "aborted");
      return;
    }
    const response = finalAssistantText([event.message]);
    if (!response) return;
    if (turn.lane === "routing") {
      await finishRouting(turn, response, ctx);
      return;
    }
    await finishSuccess(turn, response, ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    latestCtx = ctx;
    const turn = active;
    if (!turn) return;
    if (wasRunAborted(event.messages)) {
      await finishFailure(turn, "aborted");
      return;
    }
    const response = finalAssistantText(event.messages);
    if (!response) return;
    if (turn.lane === "routing") {
      await finishRouting(turn, response, ctx);
      return;
    }
    await finishSuccess(turn, response, ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    latestCtx = ctx;
    const turn = active;
    if (turn) {
      await finishFailure(turn, "model_error");
      return;
    }
    const settledPhase = settleTaskContinuation(taskContinuationPhase);
    if (settledPhase === taskContinuationPhase) return;
    taskContinuationPhase = settledPhase;
    taskContinuationId = undefined;
    void sync(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    latestCtx = ctx;
    const turn = active;
    if (turn) await finishFailure(turn, "session_ended");
    taskContinuationPhase = "idle";
    taskContinuationId = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    latestCtx = undefined;
  });
}
