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
  type RegistryDelegateOutcome,
  type RegistryDelegateRequest,
  type RegistryOutcomeRequest,
  type RegistryOutcomeResult,
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
import { remoteBridgeDatabasePath } from "./paths.ts";
import { remoteKanbanResponse } from "./remote-commands.ts";
import {
  canClaimRemoteTurn,
  settleTaskContinuation,
  type TaskContinuationPhase,
} from "./routing-gate.ts";
import {
  BRIDGE_AGENT_TTL_MS,
  RemoteBridgeError,
  finalAssistantText,
  normalizeLegacyRemoteImageContent,
  parseOutcomeEnvelope,
  parseRoutePlan,
  routingBatchPrompt,
  remoteTurnContent,
  trimDispatchContext,
  type OutcomeEnvelope,
  type RemoteFailure,
  type RemoteMessage,
} from "./protocol.ts";
import { makeRemoteBridgeStore } from "./sqlite-store.ts";
import { enterRemoteToolGuard, type RemoteToolGuard } from "./tool-guard.ts";

const POLL_MS = 2_000;
const STATUS_KEY = "remote-control";
const DISPATCH_CONTEXT_BUDGET_CHARS = 60_000;

interface ClaimedBridgeMessage {
  readonly id: string;
  readonly claimToken: string;
  readonly text: string;
}

interface ActiveRemoteTurn {
  readonly messageId: string;
  readonly claimToken: string;
  readonly toolGuard: RemoteToolGuard;
  readonly lane: "conversational" | "routing";
  readonly text: string;
  readonly batch?: readonly ClaimedBridgeMessage[];
}

const safeError = (error: RemoteBridgeError): string =>
  `${error.code}: ${error.message}`.slice(0, 160);

export default function remoteControl(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "remote-control", "2026.08.03.26");
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

  const run = <A>(
    operation: Effect.Effect<A, RemoteBridgeError>,
  ): Promise<Either.Either<A, RemoteBridgeError>> =>
    Effect.runPromise(Effect.either(operation));

  pi.events.on(QUESTION_STATE_EVENT, (snapshot: UserQuestionStateSnapshot) => {
    questionState = snapshot;
    questionsDirty = true;
  });

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
    const result = await run(
      store.fail({
        messageId: turn.messageId,
        claimToken: turn.claimToken,
        failure,
        now: Date.now(),
      }),
    );
    if (Either.isLeft(result) && result.left.code !== "invalid_transition") {
      latestCtx?.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(result.left)}`,
      );
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

  const delegateToProject = (
    project: string,
    text: string,
    ctx: ExtensionContext,
  ): Promise<RegistryDelegateOutcome> =>
    new Promise((resolve) => {
      const timeout = setTimeout(
        () =>
          resolve({ outcome: "failed", reason: "registry delegate timed out" }),
        5_000,
      );
      const request: RegistryDelegateRequest = {
        project,
        role: "receiver",
        text,
        requesterId: "telegram-dispatch",
        requesterLabel: "Piece of Pi Telegram dispatch",
        requesterCwd: ctx.cwd,
        report: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
      };
      pi.events.emit(REGISTRY_DELEGATE_REQUEST_EVENT, request);
    });

  const finishEnvelope = async (
    message: ClaimedBridgeMessage,
    envelope: OutcomeEnvelope,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const recorded = await new Promise<RegistryOutcomeResult>((resolve) => {
      const timeout = setTimeout(
        () =>
          resolve({ outcome: "failed", reason: "registry outcome timed out" }),
        5_000,
      );
      const request: RegistryOutcomeRequest = {
        requestId: envelope.requestId,
        resolution: envelope.outcome,
        summary: envelope.summary,
        report: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
      };
      pi.events.emit(REGISTRY_OUTCOME_EVENT, request);
    });
    const body =
      envelope.outcome === "failed"
        ? `Receiver failed request ${envelope.requestId}: ${envelope.summary}`
        : envelope.summary;
    const suffix =
      recorded.outcome === "failed"
        ? ` (registry record pending: ${recorded.reason})`
        : "";
    const completed = await run(
      store.complete({
        messageId: message.id,
        claimToken: message.claimToken,
        response: `${body}${suffix}`,
        now: Date.now(),
      }),
    );
    if (Either.isLeft(completed)) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(completed.left)}`,
      );
    }
  };

  const finishRouting = async (
    turn: ActiveRemoteTurn,
    response: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const batch = turn.batch ?? [];
    const plan = parseRoutePlan(response, batch.length);
    const routed = new Set(plan.flatMap((directive) => [...directive.indexes]));
    const fallback = batch
      .map((_, position) => position + 1)
      .filter((index) => !routed.has(index));
    const directives = [
      ...plan,
      ...(fallback.length > 0
        ? [{ project: ctx.cwd, indexes: fallback }]
        : []),
    ];
    const acks = new Map<number, string[]>();
    for (const directive of directives) {
      const bundle = [
        ...(directive.note ? [`Dispatcher note: ${directive.note}`] : []),
        ...directive.indexes.map((index) => batch[index - 1]?.text ?? ""),
      ]
        .filter((part) => part.length > 0)
        .join("\n\n---\n\n");
      const outcome = await delegateToProject(directive.project, bundle, ctx);
      const ack =
        outcome.outcome === "queued"
          ? `${directive.project} (request ${outcome.requestId})`
          : `${directive.project} FAILED: ${outcome.reason}`;
      for (const index of directive.indexes) {
        acks.set(index, [...(acks.get(index) ?? []), ack]);
      }
    }
    clearActive(turn);
    for (const [position, message] of batch.entries()) {
      const destinations = acks.get(position + 1) ?? ["nowhere - routing plan empty"];
      const completed = await run(
        store.complete({
          messageId: message.id,
          claimToken: message.claimToken,
          response: `Routed to ${destinations.join("; ")}.`,
          now: Date.now(),
        }),
      );
      if (Either.isLeft(completed)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(completed.left)}`,
        );
      }
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
    const content = remoteTurnContent(
      message.text,
      message.images,
      "conversational",
    );
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
    const roster = await Effect.runPromise(
      Effect.either(store.listAgents(Date.now())),
    );
    const prompt = routingBatchPrompt(
      batch.map((message, position) => ({
        index: position + 1,
        text: message.text,
      })),
      Either.isRight(roster)
        ? roster.right.map(({ id, label, cwd }) => ({ id, label, cwd }))
        : [],
    );
    const sent = await Effect.runPromise(
      Effect.either(
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
      ),
    );
    if (Either.isLeft(sent)) {
      await finishRouting(turn, "", ctx);
    }
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
        const routable: ClaimedBridgeMessage[] = [];
        while (routable.length < 16) {
          const claimed = await run(
            store.claimNext({
              agentId: ctx.sessionManager.getSessionId(),
              now: Date.now(),
            }),
          );
          if (Either.isLeft(claimed)) {
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
            text: claimed.right.text,
          };
          const envelope = parseOutcomeEnvelope(message.text);
          if (envelope) {
            await finishEnvelope(message, envelope, ctx);
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
          routable.push(message);
        }
        if (routable.length > 0) await beginRoutingTurn(routable, ctx);
        else ctx.ui.setStatus(STATUS_KEY, undefined);
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
      );
      return { messages: [...trimmed.messages] };
    }
    return { messages };
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    if (timer) clearInterval(timer);
    timer = setInterval(() => void sync(ctx), POLL_MS);
    timer.unref();
    void sync(ctx);
  });

  pi.on("before_agent_start", () => {
    active?.toolGuard.enforce();
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
