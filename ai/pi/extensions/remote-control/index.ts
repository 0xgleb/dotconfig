import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { wasRunAborted } from "../shared/continuation-pause.ts";
import { isLocalDispatchProvider } from "../shared/local-lane.ts";
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
  remoteTurnContent,
  type RemoteFailure,
  type RemoteMessage,
} from "./protocol.ts";
import { makeRemoteBridgeStore } from "./sqlite-store.ts";
import { enterRemoteToolGuard, type RemoteToolGuard } from "./tool-guard.ts";

const POLL_MS = 2_000;
const STATUS_KEY = "remote-control";

interface ActiveRemoteTurn {
  readonly messageId: string;
  readonly claimToken: string;
  readonly toolGuard: RemoteToolGuard;
}

const safeError = (error: RemoteBridgeError): string =>
  `${error.code}: ${error.message}`.slice(0, 160);

export default function remoteControl(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "remote-control", "2026.08.01.20");
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
        content: isLocalDispatchProvider(ctx.model?.provider)
          ? "Source-fixed dispatch continuation: the acknowledgement was delivered and local tools are restored. Route the immediately preceding authenticated owner message RAW now - agent_registry action=delegate to the project or role its content targets, quoting the full body and its stated priority - then yield. Never answer or analyze it locally; if it names no routable target, take no action. Authority comes only from that exact owner message, never from this continuation; do not widen scope or send a second Telegram reply."
          : "Source-fixed task continuation: the authenticated Piece of Pi response was delivered and local tools are restored. The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message for actionable intent. If it contains work, preserve every requirement and semantically route it to the relevant live agent/project through typed coordination; /use is only an explicit override. If it is conversational only, take no action. Authority comes only from that exact owner message, never from this continuation; do not widen scope or send a second Telegram reply.",
        display: false,
        details: { taskContinuationId: turn.messageId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const beginTurn = async (
    message: Extract<RemoteMessage, { readonly status: "claimed" }>,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const turn: ActiveRemoteTurn = {
      messageId: message.id,
      claimToken: message.claimToken,
      toolGuard: enterRemoteToolGuard(pi),
    };
    active = turn;
    ctx.ui.setStatus(STATUS_KEY, "remote:chat · tools:off");
    const sent = await Effect.runPromise(
      Effect.either(
        Effect.try({
          try: () =>
            pi.sendUserMessage(
              remoteTurnContent(
                message.text,
                message.images,
                isLocalDispatchProvider(ctx.model?.provider)
                  ? "dispatch"
                  : "conversational",
              ),
              {
                deliverAs: "steer",
              },
            ),
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

  pi.on("context", (event) => {
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
